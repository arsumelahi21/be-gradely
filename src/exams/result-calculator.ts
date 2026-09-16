// Pure result arithmetic (no Prisma, no I/O, no clock) — the ONLY place marks become
// percentages, grades and pass/fail; every sheet, card, register and dashboard reads from here.
//
// - A paper's denominator is its own total marks, never an assumed 100.
// - Aggregates add MARKS, not percentages: overall % = Σobtained / Σtotal. The data model has
//   no exam or subject weights, so nothing is weighted or averaged.
// - Grades and pass/fail are decided on the exact fraction; the 2dp percentage is display only.
// - Absent scores 0 and fails that subject; unentered marks leave a result incomplete (no %,
//   grade or verdict) — never a silent zero.
// - A subject passes on its passing marks when set, else on its grade band; the overall result
//   passes only when every subject does.

export interface GradeBandInput {
  label: string;
  minPercent: number;
  isPassing: boolean;
  remark?: string | null;
}

/** Seeded for every school; 40% pass mark matches the dashboard's former PASS_PERCENT. */
export const DEFAULT_GRADE_BANDS: GradeBandInput[] = [
  { label: 'A+', minPercent: 90, isPassing: true, remark: 'Outstanding' },
  { label: 'A', minPercent: 80, isPassing: true, remark: 'Excellent' },
  { label: 'B', minPercent: 70, isPassing: true, remark: 'Very good' },
  { label: 'C', minPercent: 60, isPassing: true, remark: 'Good' },
  { label: 'D', minPercent: 50, isPassing: true, remark: 'Satisfactory' },
  { label: 'E', minPercent: 40, isPassing: true, remark: 'Needs improvement' },
  { label: 'F', minPercent: 0, isPassing: false, remark: 'Fail' },
];

/**
 * A band runs from its minimum up to (not including) the next band's minimum, so ranges can't
 * overlap or leave gaps once one band starts at 0. Passing must be one contiguous top range.
 */
export function validateBands(bands: GradeBandInput[]): string[] {
  const problems: string[] = [];
  if (bands.length === 0) return ['Add at least one grade band'];
  const mins = new Set<number>();
  const labels = new Set<string>();
  for (const b of bands) {
    const label = b.label.trim();
    if (!label) problems.push('Every band needs a grade label');
    if (
      !Number.isInteger(b.minPercent) ||
      b.minPercent < 0 ||
      b.minPercent > 100
    )
      problems.push(
        `${label || 'A band'}: minimum % must be a whole number from 0 to 100`,
      );
    if (mins.has(b.minPercent))
      problems.push(`Two bands start at ${b.minPercent}%`);
    if (labels.has(label.toLowerCase()))
      problems.push(`Grade "${label}" is used twice`);
    mins.add(b.minPercent);
    labels.add(label.toLowerCase());
  }
  if (!mins.has(0))
    problems.push('One band must start at 0% so every score gets a grade');
  if (!bands.some((b) => b.isPassing))
    problems.push('At least one band must be passing');
  if (!bands.some((b) => !b.isPassing))
    problems.push(
      'At least one band must be failing, otherwise no score could ever fail',
    );
  const ascending = [...bands].sort((a, b) => a.minPercent - b.minPercent);
  const firstPass = ascending.findIndex((b) => b.isPassing);
  if (firstPass >= 0 && ascending.slice(firstPass).some((b) => !b.isPassing))
    problems.push(
      'A failing band cannot sit above a passing one: passing grades must be the top grades',
    );
  return problems;
}

/** The pass mark a scheme implies: the lowest minimum among its passing bands. */
export function passMarkPercent(bands: GradeBandInput[]): number | null {
  const passing = bands.filter((b) => b.isPassing).map((b) => b.minPercent);
  return passing.length ? Math.min(...passing) : null;
}

/**
 * Display percentage, rounded half-up to 2dp from the exact fraction. Whole-number marks use
 * integer arithmetic, so 3/800 is 0.38 rather than float-drifting to 0.37. Never grade from it.
 */
export function percentOf(obtained: number, total: number): number | null {
  if (!(total > 0)) return null;
  if (Number.isInteger(obtained) && Number.isInteger(total) && obtained >= 0) {
    return Math.floor((obtained * 20000 + total) / (2 * total)) / 100;
  }
  return Math.round((obtained / total) * 10000) / 100;
}

/**
 * The band a mark falls in, compared on the exact fraction (obtained·100 ≥ min·total), so a
 * result that only rounds up to a boundary — 79.995% — stays in the band below it.
 */
export function gradeForMarks(
  obtained: number,
  total: number,
  bands: GradeBandInput[],
): GradeBandInput | null {
  if (!(total > 0)) return null;
  const sorted = [...bands].sort((a, b) => b.minPercent - a.minPercent);
  return sorted.find((b) => obtained * 100 >= b.minPercent * total) ?? null;
}

export type SubjectState = 'PASS' | 'FAIL' | 'ABSENT' | 'MISSING' | 'INVALID';

export interface SubjectMarkInput {
  examId: string;
  label: string;
  maxScore: number | null;
  passingMarks: number | null;
  score: number | null;
  isAbsent: boolean;
}

export interface SubjectOutcome {
  examId: string;
  label: string;
  state: SubjectState;
  obtained: number | null;
  maxScore: number | null;
  percentage: number | null;
  grade: string | null;
  passed: boolean | null;
  issue: string | null;
}

export function subjectOutcome(
  s: SubjectMarkInput,
  bands: GradeBandInput[],
): SubjectOutcome {
  const base = {
    examId: s.examId,
    label: s.label,
    maxScore: s.maxScore,
  };
  if (s.maxScore == null || s.maxScore <= 0) {
    return {
      ...base,
      state: 'INVALID',
      obtained: null,
      percentage: null,
      grade: null,
      passed: null,
      issue: 'Total marks not set',
    };
  }
  if (s.isAbsent) {
    const grade = gradeForMarks(0, s.maxScore, bands);
    return {
      ...base,
      state: 'ABSENT',
      obtained: 0,
      percentage: 0,
      grade: grade?.label ?? null,
      passed: false,
      issue: null,
    };
  }
  if (s.score == null) {
    return {
      ...base,
      state: 'MISSING',
      obtained: null,
      percentage: null,
      grade: null,
      passed: null,
      issue: 'Marks not entered',
    };
  }
  if (!Number.isInteger(s.score) || s.score < 0 || s.score > s.maxScore) {
    return {
      ...base,
      state: 'INVALID',
      obtained: s.score,
      percentage: null,
      grade: null,
      passed: null,
      issue: `Marks must be between 0 and ${s.maxScore}`,
    };
  }
  const band = gradeForMarks(s.score, s.maxScore, bands);
  const passed =
    s.passingMarks != null
      ? s.score >= s.passingMarks
      : (band?.isPassing ?? false);
  return {
    ...base,
    state: passed ? 'PASS' : 'FAIL',
    obtained: s.score,
    percentage: percentOf(s.score, s.maxScore),
    grade: band?.label ?? null,
    passed,
    issue: null,
  };
}

export interface StudentOutcome {
  complete: boolean;
  totalObtained: number;
  totalMax: number;
  percentage: number | null;
  grade: string | null;
  passed: boolean | null;
  failedSubjects: string[];
  /** The overall % lands in a failing grade band, whatever the subjects did. */
  belowPassMark: boolean;
  subjects: SubjectOutcome[];
}

/**
 * Overall pass means passing EVERY subject AND an overall % in a passing grade band, so a result
 * can never read "F" and "Pass" together. Incomplete results get no grade or verdict.
 */
export function studentOutcome(
  subjects: SubjectMarkInput[],
  bands: GradeBandInput[],
): StudentOutcome {
  const outcomes = subjects.map((s) => subjectOutcome(s, bands));
  const complete =
    outcomes.length > 0 &&
    outcomes.every((o) => o.state !== 'MISSING' && o.state !== 'INVALID');
  const totalObtained = outcomes.reduce((sum, o) => sum + (o.obtained ?? 0), 0);
  const totalMax = outcomes.reduce((sum, o) => sum + (o.maxScore ?? 0), 0);
  const failedSubjects = outcomes
    .filter((o) => o.state === 'FAIL' || o.state === 'ABSENT')
    .map((o) => o.label);

  if (!complete) {
    return {
      complete,
      totalObtained,
      totalMax,
      percentage: null,
      grade: null,
      passed: null,
      failedSubjects,
      belowPassMark: false,
      subjects: outcomes,
    };
  }
  const band = gradeForMarks(totalObtained, totalMax, bands);
  const belowPassMark = !!band && !band.isPassing;
  return {
    complete,
    totalObtained,
    totalMax,
    percentage: percentOf(totalObtained, totalMax),
    grade: band?.label ?? null,
    passed: failedSubjects.length === 0 && !belowPassMark,
    failedSubjects,
    belowPassMark,
    subjects: outcomes,
  };
}

/** One examination as it enters a term result: its verdict, totals and subject lines. */
export interface TermExamInput {
  examId: string;
  complete: boolean;
  totalObtained: number;
  totalMax: number;
  passed: boolean | null;
  subjects: {
    key: string;
    label: string;
    obtained: number | null;
    maxScore: number | null;
    state: SubjectState;
    grade: string | null;
    passed: boolean | null;
  }[];
}

export interface TermSubjectOutcome {
  key: string;
  label: string;
  /** Papers of this subject in the term. */
  papers: number;
  /** Σ marks across those papers (absent counts 0); null while none is marked. */
  obtained: number | null;
  /** Σ of those papers' totals. */
  maxScore: number | null;
  isAbsent: boolean;
  /** A paper of this subject is still unmarked or holds invalid marks. */
  missing: boolean;
  passed: boolean | null;
  /** Each paper's own grade, in exam order — a subject is never re-graded across papers. */
  grades: string[];
}

export interface TermOutcome {
  examCount: number;
  complete: boolean;
  totalObtained: number;
  totalMax: number;
  percentage: number | null;
  grade: string | null;
  remark: string | null;
  passed: boolean | null;
  failedSubjects: string[];
  belowPassMark: boolean;
  subjects: TermSubjectOutcome[];
}

/**
 * A term's examinations combined by adding marks (Σobtained / Σtotal), the same rule one
 * examination uses across its subjects. Complete only when every examination is complete;
 * passes only when every examination passes and the term % is in a passing band.
 */
export function termOutcome(
  exams: TermExamInput[],
  bands: GradeBandInput[],
): TermOutcome {
  const totalObtained = exams.reduce((sum, e) => sum + e.totalObtained, 0);
  const totalMax = exams.reduce((sum, e) => sum + e.totalMax, 0);
  const complete = exams.length > 0 && exams.every((e) => e.complete);

  const lines = new Map<
    string,
    TermSubjectOutcome & { verdicts: (boolean | null)[] }
  >();
  const failed: string[] = [];
  for (const exam of exams) {
    for (const s of exam.subjects) {
      const line = lines.get(s.key) ?? {
        key: s.key,
        label: s.label,
        papers: 0,
        obtained: null,
        maxScore: null,
        isAbsent: false,
        missing: false,
        passed: null,
        grades: [],
        verdicts: [],
      };
      line.papers += 1;
      if (s.maxScore != null) line.maxScore = (line.maxScore ?? 0) + s.maxScore;
      if (s.state === 'ABSENT') {
        line.isAbsent = true;
        line.obtained = line.obtained ?? 0;
      } else if (s.state === 'PASS' || s.state === 'FAIL') {
        line.obtained = (line.obtained ?? 0) + (s.obtained ?? 0);
      } else {
        line.missing = true;
      }
      if (s.grade) line.grades.push(s.grade);
      line.verdicts.push(s.passed);
      if (
        (s.state === 'FAIL' || s.state === 'ABSENT') &&
        !failed.includes(s.label)
      )
        failed.push(s.label);
      lines.set(s.key, line);
    }
  }
  const subjects = [...lines.values()].map(({ verdicts, ...line }) => ({
    ...line,
    passed: verdicts.includes(false)
      ? false
      : verdicts.length > 0 && verdicts.every((v) => v === true)
        ? true
        : null,
  }));

  const band = complete ? gradeForMarks(totalObtained, totalMax, bands) : null;
  const belowPassMark = !!band && !band.isPassing;
  return {
    examCount: exams.length,
    complete,
    totalObtained,
    totalMax,
    percentage: complete ? percentOf(totalObtained, totalMax) : null,
    grade: band?.label ?? null,
    remark: band?.remark ?? null,
    passed: complete
      ? exams.every((e) => e.passed === true) && !belowPassMark
      : null,
    failedSubjects: failed,
    belowPassMark,
    subjects,
  };
}

/** Class-sheet header for a term: one column per subject, in exam order, with Σ paper totals. */
export function termSubjectColumns(
  exams: {
    subjects: { key: string; label: string; maxScore: number | null }[];
  }[],
): { key: string; label: string; papers: number; maxScore: number | null }[] {
  const columns = new Map<
    string,
    { key: string; label: string; papers: number; maxScore: number | null }
  >();
  for (const exam of exams) {
    for (const s of exam.subjects) {
      const column = columns.get(s.key) ?? {
        key: s.key,
        label: s.label,
        papers: 0,
        maxScore: null,
      };
      column.papers += 1;
      if (s.maxScore != null)
        column.maxScore = (column.maxScore ?? 0) + s.maxScore;
      columns.set(s.key, column);
    }
  }
  return [...columns.values()];
}

/**
 * Competition ranking (1, 1, 3) over complete results, compared on exact fractions so
 * rounding can't split or merge ties.
 */
export function assignPositions(
  rows: {
    studentId: string;
    totalObtained: number;
    totalMax: number;
    complete: boolean;
  }[],
): Map<string, number> {
  const ranked = rows
    .filter((r) => r.complete && r.totalMax > 0)
    .sort(
      (a, b) => b.totalObtained * a.totalMax - a.totalObtained * b.totalMax,
    );
  const positions = new Map<string, number>();
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    const tied =
      prev &&
      prev.totalObtained * r.totalMax === r.totalObtained * prev.totalMax;
    positions.set(r.studentId, tied ? positions.get(prev.studentId)! : i + 1);
  });
  return positions;
}

/** Statistics over exact fractions, rounded once at the end rather than per student. */
const exactPercent = (obtained: number, total: number) =>
  (obtained / total) * 100;
const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / values.length;

export interface ClassSummary {
  totalStudents: number;
  complete: number;
  incomplete: number;
  passed: number;
  failed: number;
  averagePercentage: number | null;
  highestPercentage: number | null;
  lowestPercentage: number | null;
}

/** Class average is the mean of each student's own percentage: every student counts once. */
export function summarizeClass(outcomes: StudentOutcome[]): ClassSummary {
  const done = outcomes.filter((o) => o.complete && o.totalMax > 0);
  const pcts = done.map((o) => exactPercent(o.totalObtained, o.totalMax));
  return {
    totalStudents: outcomes.length,
    complete: done.length,
    incomplete: outcomes.length - done.length,
    passed: done.filter((o) => o.passed).length,
    failed: done.filter((o) => o.passed === false).length,
    averagePercentage: pcts.length ? round2(mean(pcts)) : null,
    highestPercentage: pcts.length ? round2(Math.max(...pcts)) : null,
    lowestPercentage: pcts.length ? round2(Math.min(...pcts)) : null,
  };
}

export interface SubjectPerformance {
  examId: string;
  label: string;
  entered: number;
  passed: number;
  failed: number;
  absent: number;
  averagePercentage: number | null;
  highestScore: number | null;
}

/** Subject average covers students who sat the paper; absentees are counted separately. */
export function summarizeSubjects(
  outcomes: StudentOutcome[],
): SubjectPerformance[] {
  const byExam = new Map<string, SubjectOutcome[]>();
  for (const o of outcomes) {
    for (const s of o.subjects) {
      byExam.set(s.examId, [...(byExam.get(s.examId) ?? []), s]);
    }
  }
  return [...byExam.entries()].map(([examId, rows]) => {
    const scored = rows.filter((r) => r.state === 'PASS' || r.state === 'FAIL');
    const pcts = scored.map((r) =>
      exactPercent(r.obtained as number, r.maxScore as number),
    );
    return {
      examId,
      label: rows[0].label,
      entered: scored.length + rows.filter((r) => r.state === 'ABSENT').length,
      passed: rows.filter((r) => r.state === 'PASS').length,
      failed: rows.filter((r) => r.state === 'FAIL').length,
      absent: rows.filter((r) => r.state === 'ABSENT').length,
      averagePercentage: pcts.length ? round2(mean(pcts)) : null,
      highestScore: scored.length
        ? Math.max(...scored.map((r) => r.obtained as number))
        : null,
    };
  });
}

export interface ResultAggregate {
  academicYear: { id: string; name: string };
  examCount: number;
  totalObtained: number;
  totalMax: number;
  percentage: number | null;
}

/**
 * A student's finalized examinations summed per academic session (Σobtained / Σtotal) — never
 * across sessions and never as a mean of exam percentages. Newest session first.
 */
export function aggregateBySession(
  rows: {
    academicYear: { id: string; name: string };
    finalizedAt: Date | string | null;
    totalObtained: number | null;
    totalMax: number | null;
    percentage: number | null;
  }[],
): ResultAggregate[] {
  const sessions = new Map<string, ResultAggregate & { latest: number }>();
  for (const r of rows) {
    // Only complete results count; an incomplete one has totals but no percentage.
    if (
      r.percentage == null ||
      r.totalObtained == null ||
      r.totalMax == null ||
      r.totalMax <= 0
    )
      continue;
    const at = r.finalizedAt ? new Date(r.finalizedAt).getTime() : 0;
    const s = sessions.get(r.academicYear.id) ?? {
      academicYear: r.academicYear,
      examCount: 0,
      totalObtained: 0,
      totalMax: 0,
      percentage: null,
      latest: 0,
    };
    s.examCount += 1;
    s.totalObtained += r.totalObtained;
    s.totalMax += r.totalMax;
    s.latest = Math.max(s.latest, at);
    sessions.set(r.academicYear.id, s);
  }
  return [...sessions.values()]
    .sort(
      (a, b) =>
        b.latest - a.latest ||
        a.academicYear.id.localeCompare(b.academicYear.id),
    )
    .map(({ latest: _latest, ...s }) => ({
      ...s,
      percentage: percentOf(s.totalObtained, s.totalMax),
    }));
}
