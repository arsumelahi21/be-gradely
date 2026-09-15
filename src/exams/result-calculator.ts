// Pure result arithmetic (no Prisma, no I/O, no clock) — the only place marks become
// percentages, grades and pass/fail. Marks are whole numbers; percentages round to 2dp.

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

export function validateBands(bands: GradeBandInput[]): string[] {
  const problems: string[] = [];
  if (bands.length === 0) return ['Add at least one grade band'];
  const mins = new Set<number>();
  const labels = new Set<string>();
  for (const b of bands) {
    const label = b.label.trim();
    if (!label) problems.push('Every band needs a grade label');
    if (!Number.isInteger(b.minPercent) || b.minPercent < 0 || b.minPercent > 100)
      problems.push(`${label || 'A band'}: minimum % must be a whole number from 0 to 100`);
    if (mins.has(b.minPercent))
      problems.push(`Two bands start at ${b.minPercent}%`);
    if (labels.has(label.toLowerCase()))
      problems.push(`Grade "${label}" is used twice`);
    mins.add(b.minPercent);
    labels.add(label.toLowerCase());
  }
  if (!mins.has(0)) problems.push('One band must start at 0% so every score gets a grade');
  if (!bands.some((b) => b.isPassing)) problems.push('At least one band must be passing');
  return problems;
}

/** 2dp percentage; null when there is nothing to divide by. */
export function percentOf(obtained: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((obtained / total) * 10000) / 100;
}

export function gradeFor(
  percentage: number,
  bands: GradeBandInput[],
): GradeBandInput | null {
  const sorted = [...bands].sort((a, b) => b.minPercent - a.minPercent);
  return sorted.find((b) => percentage >= b.minPercent) ?? null;
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
    return { ...base, state: 'INVALID', obtained: null, percentage: null, grade: null, passed: null, issue: 'Total marks not set' };
  }
  if (s.isAbsent) {
    const grade = gradeFor(0, bands);
    return { ...base, state: 'ABSENT', obtained: 0, percentage: 0, grade: grade?.label ?? null, passed: false, issue: null };
  }
  if (s.score == null) {
    return { ...base, state: 'MISSING', obtained: null, percentage: null, grade: null, passed: null, issue: 'Marks not entered' };
  }
  if (!Number.isInteger(s.score) || s.score < 0 || s.score > s.maxScore) {
    return { ...base, state: 'INVALID', obtained: s.score, percentage: null, grade: null, passed: null, issue: `Marks must be between 0 and ${s.maxScore}` };
  }
  const percentage = percentOf(s.score, s.maxScore) ?? 0;
  const band = gradeFor(percentage, bands);
  const passed =
    s.passingMarks != null ? s.score >= s.passingMarks : (band?.isPassing ?? false);
  return {
    ...base,
    state: passed ? 'PASS' : 'FAIL',
    obtained: s.score,
    percentage,
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
  subjects: SubjectOutcome[];
}

/** Overall pass means passing EVERY subject; incomplete results get no grade or verdict. */
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
    return { complete, totalObtained, totalMax, percentage: null, grade: null, passed: null, failedSubjects, subjects: outcomes };
  }
  const percentage = percentOf(totalObtained, totalMax);
  return {
    complete,
    totalObtained,
    totalMax,
    percentage,
    grade: percentage == null ? null : (gradeFor(percentage, bands)?.label ?? null),
    passed: failedSubjects.length === 0,
    failedSubjects,
    subjects: outcomes,
  };
}

/**
 * Competition ranking (1, 1, 3) over complete results, compared on exact fractions so
 * rounding can't split or merge ties.
 */
export function assignPositions(
  rows: { studentId: string; totalObtained: number; totalMax: number; complete: boolean }[],
): Map<string, number> {
  const ranked = rows
    .filter((r) => r.complete && r.totalMax > 0)
    .sort((a, b) => b.totalObtained * a.totalMax - a.totalObtained * b.totalMax);
  const positions = new Map<string, number>();
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    const tied =
      prev && prev.totalObtained * r.totalMax === r.totalObtained * prev.totalMax;
    positions.set(r.studentId, tied ? positions.get(prev.studentId)! : i + 1);
  });
  return positions;
}

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

export function summarizeClass(outcomes: StudentOutcome[]): ClassSummary {
  const done = outcomes.filter((o) => o.complete && o.percentage != null);
  const pcts = done.map((o) => o.percentage as number);
  return {
    totalStudents: outcomes.length,
    complete: done.length,
    incomplete: outcomes.length - done.length,
    passed: done.filter((o) => o.passed).length,
    failed: done.filter((o) => o.passed === false).length,
    averagePercentage: pcts.length
      ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100
      : null,
    highestPercentage: pcts.length ? Math.max(...pcts) : null,
    lowestPercentage: pcts.length ? Math.min(...pcts) : null,
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

export function summarizeSubjects(outcomes: StudentOutcome[]): SubjectPerformance[] {
  const byExam = new Map<string, SubjectOutcome[]>();
  for (const o of outcomes) {
    for (const s of o.subjects) {
      byExam.set(s.examId, [...(byExam.get(s.examId) ?? []), s]);
    }
  }
  return [...byExam.entries()].map(([examId, rows]) => {
    const scored = rows.filter((r) => r.state === 'PASS' || r.state === 'FAIL');
    const pcts = scored.map((r) => r.percentage as number);
    return {
      examId,
      label: rows[0].label,
      entered: scored.length + rows.filter((r) => r.state === 'ABSENT').length,
      passed: rows.filter((r) => r.state === 'PASS').length,
      failed: rows.filter((r) => r.state === 'FAIL').length,
      absent: rows.filter((r) => r.state === 'ABSENT').length,
      averagePercentage: pcts.length
        ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100
        : null,
      highestScore: scored.length
        ? Math.max(...scored.map((r) => r.obtained as number))
        : null,
    };
  });
}
