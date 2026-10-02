import { Injectable } from '@nestjs/common';
import { percentOf } from '../exams/result-calculator';
import { CLASS_LEVELS } from '../common/types/class-level.type';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
} from './director.service';
import { DirectorQueriesService } from './director.queries';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { Ratio, daysSince, ratio } from './insights';

// 00 §7: a published examination whose last paper was more than 14 days ago should have results.
const RESULTS_OVERDUE_DAYS = 14;
const WEAKEST_LIMIT = 5;
// Too few marks say more about one class than about the subject.
const SUBJECT_MIN_MARKS = 10;
const DAY_MS = 86_400_000;

/** Mark-weighted like a report card: percentOf(Σ obtained, Σ max), never a mean of percentages. */
interface Score {
  obtained: number;
  max: number;
  avgScorePercent: number | null;
  pass: Ratio;
}

interface SubjectMarks {
  key: string;
  name: string;
  obtained: number;
  max: number;
  marks: number;
}

export interface AcademicsData {
  results: Score | null;
  /** The whole session before the selected one. */
  resultsBefore: Score | null;
  /** In term order; exams without a term are left out. */
  byTerm: ({ name: string } & Score)[] | null;
  subjects: SubjectMarks[] | null;
  byLevel:
    | ({ key: string; label: string; level: number | null } & Score)[]
    | null;
  /** Only when one branch is shown. Class names, never students. */
  weakest?: {
    className: string;
    sectionName: string;
    avgScorePercent: number | null;
    pass: Ratio;
  }[];
  resultsOverdue: number | null;
  reviews: { pending: number; oldestAgeDays: number | null };
}

export interface AcademicsGroup {
  results: Score;
  resultsBefore: Score;
  /** Terms lined up by their order in each branch's session, since names and ids differ. */
  byTerm: ({ label: string } & Score)[];
  /** Lowest average mark first, matched by subject name across branches. */
  weakestSubjects: {
    name: string;
    avgScorePercent: number | null;
    branches: number;
    marks: number;
  }[];
  byLevel: ({ key: string; label: string; level: number | null } & Score)[];
  resultsOverdue: number;
  reviews: { pending: number; oldestAgeDays: number | null };
}

const LEVEL_LABEL = new Map(CLASS_LEVELS.map((l) => [l.value, l.label]));

const score = (
  obtained: number,
  max: number,
  passed: number,
  decided: number,
): Score => ({
  obtained,
  max,
  avgScorePercent: percentOf(obtained, max),
  pass: ratio(passed, decided),
});

const add = (a: Score, b: Score) =>
  score(
    a.obtained + b.obtained,
    a.max + b.max,
    a.pass.num + b.pass.num,
    a.pass.den + b.pass.den,
  );

/** Academics (06-ACADEMICS.md): finalized exam results and what is holding exams up. */
@Injectable()
export class DirectorAcademicsService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
  ) {}

  insights(scope: DirectorScope, query: InsightsQueryDto) {
    return this.director.insights<AcademicsData, AcademicsGroup>(
      scope,
      query,
      (ctx) => this.branchAcademics(ctx),
      (rows) => this.rollUp(rows),
    );
  }

  private async branchAcademics(ctx: BranchContext): Promise<AcademicsData> {
    const { branch, year, priorYear, now, single } = ctx;
    const cutoff = new Date(now.getTime() - RESULTS_OVERDUE_DAYS * DAY_MS);
    const [sections, backlog, overdue, before, terms, subjects] =
      await Promise.all([
        year ? this.queries.examResults(branch.id, year.id) : null,
        this.queries.examBacklog(branch.id),
        year ? this.queries.unfinalizedExams(branch.id, year.id, cutoff) : null,
        priorYear ? this.queries.examResults(branch.id, priorYear.id) : null,
        year ? this.queries.examResultsByTerm(branch.id, year.id) : null,
        year ? this.queries.subjectScores(branch.id, year.id) : null,
      ]);
    const reviews = {
      pending: backlog.pending,
      oldestAgeDays: backlog.oldestSubmittedAt
        ? daysSince(new Date(backlog.oldestSubmittedAt), now)
        : null,
    };
    if (!sections)
      return {
        results: null,
        resultsBefore: null,
        byTerm: null,
        subjects: null,
        byLevel: null,
        resultsOverdue: null,
        reviews,
      };

    let results = score(0, 0, 0, 0);
    const levels = new Map<
      string,
      { key: string; label: string; level: number | null } & Score
    >();
    for (const r of sections) {
      const cell = score(r.obtained, r.max, r.passed, r.decided);
      results = add(results, cell);
      const key =
        r.level === null
          ? `name:${r.className.trim().toLowerCase()}`
          : String(r.level);
      const prev = levels.get(key);
      levels.set(key, {
        key,
        level: r.level,
        label:
          (r.level !== null && LEVEL_LABEL.get(r.level)) || r.className.trim(),
        ...(prev ? add(prev, cell) : cell),
      });
    }

    return {
      results,
      resultsBefore: before
        ? before.reduce(
            (acc, r) => add(acc, score(r.obtained, r.max, r.passed, r.decided)),
            score(0, 0, 0, 0),
          )
        : null,
      byTerm: (terms ?? []).map((t) => ({
        name: t.name,
        ...score(t.obtained, t.max, t.passed, t.decided),
      })),
      subjects,
      byLevel: sortLevels([...levels.values()]),
      resultsOverdue: overdue,
      reviews,
      ...(single && {
        weakest: sections
          .map((r) => ({
            className: r.className,
            sectionName: r.sectionName,
            avgScorePercent: percentOf(r.obtained, r.max),
            pass: ratio(r.passed, r.decided),
          }))
          .sort((a, b) => (a.pass.value ?? 1) - (b.pass.value ?? 1))
          .slice(0, WEAKEST_LIMIT),
      }),
    };
  }

  private rollUp(rows: BranchResult<AcademicsData>[]): AcademicsGroup {
    let results = score(0, 0, 0, 0);
    let resultsBefore = score(0, 0, 0, 0);
    const terms: { names: Set<string>; score: Score }[] = [];
    const subjects = new Map<
      string,
      {
        name: string;
        obtained: number;
        max: number;
        marks: number;
        branches: number;
      }
    >();
    let resultsOverdue = 0;
    const reviews = { pending: 0, oldestAgeDays: null as number | null };
    const levels = new Map<
      string,
      { key: string; label: string; level: number | null } & Score
    >();
    for (const { status, data } of rows) {
      if (!data) continue;
      reviews.pending += data.reviews.pending;
      if (data.reviews.oldestAgeDays !== null)
        reviews.oldestAgeDays = Math.max(
          reviews.oldestAgeDays ?? 0,
          data.reviews.oldestAgeDays,
        );
      if (status !== 'ok' || !data.results || !data.byLevel) continue;
      results = add(results, data.results);
      if (data.resultsBefore)
        resultsBefore = add(resultsBefore, data.resultsBefore);
      data.byTerm?.forEach((t, i) => {
        terms[i] ??= { names: new Set(), score: score(0, 0, 0, 0) };
        terms[i].names.add(t.name.trim());
        terms[i].score = add(terms[i].score, t);
      });
      for (const sub of data.subjects ?? []) {
        const acc = subjects.get(sub.key) ?? {
          name: sub.name,
          obtained: 0,
          max: 0,
          marks: 0,
          branches: 0,
        };
        acc.obtained += sub.obtained;
        acc.max += sub.max;
        acc.marks += sub.marks;
        acc.branches++;
        subjects.set(sub.key, acc);
      }
      resultsOverdue += data.resultsOverdue ?? 0;
      for (const l of data.byLevel) {
        const prev = levels.get(l.key);
        levels.set(l.key, prev ? { ...prev, ...add(prev, l) } : l);
      }
    }
    return {
      results,
      resultsBefore,
      byTerm: terms.map((t, i) => ({
        // One shared name reads better than "Term 2"; mixed names fall back to the position.
        label: t.names.size === 1 ? [...t.names][0] : `Term ${i + 1}`,
        ...t.score,
      })),
      weakestSubjects: [...subjects.values()]
        .filter((s) => s.marks >= SUBJECT_MIN_MARKS)
        .map((s) => ({
          name: s.name,
          avgScorePercent: percentOf(s.obtained, s.max),
          branches: s.branches,
          marks: s.marks,
        }))
        .sort((a, b) => (a.avgScorePercent ?? 100) - (b.avgScorePercent ?? 100))
        .slice(0, WEAKEST_LIMIT),
      byLevel: sortLevels([...levels.values()]),
      resultsOverdue,
      reviews,
    };
  }
}

function sortLevels<T extends { level: number | null; label: string }>(
  rows: T[],
): T[] {
  return rows.sort(
    (a, b) =>
      (a.level ?? Infinity) - (b.level ?? Infinity) ||
      a.label.localeCompare(b.label),
  );
}
