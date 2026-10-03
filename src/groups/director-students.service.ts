import { Injectable } from '@nestjs/common';
import { CLASS_LEVELS } from '../common/types/class-level.type';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
} from './director.service';
import { DirectorQueriesService, EnrolmentRow } from './director.queries';
import { InsightsQueryDto } from './dto/insights-query.dto';

interface GenderSplit {
  male: number;
  female: number;
  other: number;
  unspecified: number;
}

export interface LevelRow {
  key: string;
  level: number | null;
  label: string;
  enrolled: number;
  sections: number;
}

interface SectionStats {
  active: number;
  withStudents: number;
  empty: number;
  avgSize: { num: number; den: number; value: number | null };
}

export interface StudentsData {
  enrolled: number | null;
  unplaced: number | null;
  gender: GenderSplit | null;
  byLevel: LevelRow[] | null;
  sections: SectionStats | null;
  inactive: number;
  admissions: { count: number; monthly: { month: string; count: number }[] };
  /** Students deactivated or deleted in the window (audited only since 2026-10-01). */
  leavers: number;
}

export interface StudentsGroup {
  enrolled: number;
  unplaced: number;
  inactive: number;
  gender: GenderSplit;
  byLevel: LevelRow[];
  sections: SectionStats;
  admissions: { count: number; monthly: { month: string; count: number }[] };
  leavers: number;
}

const LEVEL_LABEL = new Map(CLASS_LEVELS.map((l) => [l.value, l.label]));

const GENDER_KEY: Record<string, keyof GenderSplit> = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
};

// Levels are a shared ladder, so they compare across branches; an unlevelled class only
// matches a class of the same name.
const levelKey = (level: number | null, name: string) =>
  level === null ? `name:${name.trim().toLowerCase()}` : String(level);

const avgSize = (num: number, den: number) => ({
  num,
  den,
  value: den === 0 ? null : Math.round((num / den) * 10) / 10,
});

const emptyGender = (): GenderSplit => ({
  male: 0,
  female: 0,
  other: 0,
  unspecified: 0,
});

function sortLevels(rows: LevelRow[]): LevelRow[] {
  return rows.sort(
    (a, b) =>
      (a.level ?? Infinity) - (b.level ?? Infinity) ||
      a.label.localeCompare(b.label),
  );
}

/** Students & Enrollment (04-STUDENTS.md). Counts only: this module never returns a name. */
@Injectable()
export class DirectorStudentsService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
  ) {}

  insights(scope: DirectorScope, query: InsightsQueryDto) {
    return this.director.insights<StudentsData, StudentsGroup>(
      scope,
      query,
      (ctx) => this.branchStudents(ctx),
      (rows) => this.rollUp(rows),
    );
  }

  async branchStudents(ctx: BranchContext): Promise<StudentsData> {
    const { branch, year, range, now } = ctx;
    const [enrolment, sections, roster, admissions, monthly, leavers] =
      await Promise.all([
        year ? this.queries.enrolment(branch.id, year.id) : null,
        year ? this.queries.activeSections(branch.id) : null,
        this.queries.roster(branch.id, year?.id ?? null),
        this.queries.admissions(branch.id, range),
        this.queries.admissionsMonthly(branch.id, now),
        this.queries.leavers(branch.id, 'STUDENT', range),
      ]);

    const base = {
      inactive: roster.inactive,
      admissions: { count: admissions, monthly },
      leavers,
    };
    if (!enrolment || !sections)
      return {
        ...base,
        enrolled: null,
        unplaced: null,
        gender: null,
        byLevel: null,
        sections: null,
      };

    const enrolled = enrolment.reduce((s, r) => s + r.n, 0);
    const placedSections = new Set(enrolment.map((r) => r.sectionId));
    return {
      ...base,
      enrolled,
      unplaced: roster.unplaced,
      gender: this.gender(enrolment),
      byLevel: this.byLevel(enrolment, sections),
      sections: {
        active: sections.length,
        withStudents: placedSections.size,
        empty: sections.filter((s) => !placedSections.has(s.id)).length,
        avgSize: avgSize(enrolled, placedSections.size),
      },
    };
  }

  private gender(rows: EnrolmentRow[]): GenderSplit {
    const split = emptyGender();
    for (const r of rows)
      split[GENDER_KEY[r.gender ?? ''] ?? 'unspecified'] += r.n;
    return split;
  }

  private byLevel(
    rows: EnrolmentRow[],
    sections: { classGrade: { name: string; level: number | null } }[],
  ): LevelRow[] {
    const levels = new Map<string, LevelRow>();
    const at = (level: number | null, name: string) => {
      const key = levelKey(level, name);
      let row = levels.get(key);
      if (!row) {
        row = {
          key,
          level,
          label: (level !== null && LEVEL_LABEL.get(level)) || name.trim(),
          enrolled: 0,
          sections: 0,
        };
        levels.set(key, row);
      }
      return row;
    };
    for (const r of rows) at(r.level, r.className).enrolled += r.n;
    for (const s of sections)
      at(s.classGrade.level, s.classGrade.name).sections++;
    return sortLevels([...levels.values()]);
  }

  /** Session figures from branches with a session; admissions and inactive from every branch (00 §5.6). */
  private rollUp(rows: BranchResult<StudentsData>[]): StudentsGroup {
    const group: StudentsGroup = {
      enrolled: 0,
      unplaced: 0,
      inactive: 0,
      gender: emptyGender(),
      byLevel: [],
      sections: {
        active: 0,
        withStudents: 0,
        empty: 0,
        avgSize: avgSize(0, 0),
      },
      admissions: { count: 0, monthly: [] },
      leavers: 0,
    };
    const levels = new Map<string, LevelRow>();
    const monthly = new Map<string, number>();

    for (const { status, data: d } of rows) {
      if (!d) continue;
      group.inactive += d.inactive;
      group.admissions.count += d.admissions.count;
      group.leavers += d.leavers;
      for (const m of d.admissions.monthly)
        monthly.set(m.month, (monthly.get(m.month) ?? 0) + m.count);

      if (status !== 'ok' || !d.sections || !d.gender || !d.byLevel) continue;
      group.enrolled += d.enrolled ?? 0;
      group.unplaced += d.unplaced ?? 0;
      for (const k of Object.keys(group.gender) as (keyof GenderSplit)[])
        group.gender[k] += d.gender[k];
      group.sections.active += d.sections.active;
      group.sections.withStudents += d.sections.withStudents;
      group.sections.empty += d.sections.empty;
      for (const l of d.byLevel) {
        const row = levels.get(l.key) ?? { ...l, enrolled: 0, sections: 0 };
        row.enrolled += l.enrolled;
        row.sections += l.sections;
        levels.set(l.key, row);
      }
    }

    group.sections.avgSize = avgSize(
      group.enrolled,
      group.sections.withStudents,
    );
    group.byLevel = sortLevels([...levels.values()]);
    group.admissions.monthly = [...monthly.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));
    return group;
  }
}
