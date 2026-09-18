// Pure examination lifecycle rules (no Prisma, no I/O) so every transition is unit-tested.
// Values mirror the Prisma enums, which are plain string unions.

export const ExaminationStatus = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  PUBLISHED: 'PUBLISHED',
  REJECTED: 'REJECTED',
} as const;
export type ExaminationStatus =
  (typeof ExaminationStatus)[keyof typeof ExaminationStatus];

export const ExaminationResultStatus = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  FINALIZED: 'FINALIZED',
} as const;
export type ExaminationResultStatus =
  (typeof ExaminationResultStatus)[keyof typeof ExaminationResultStatus];

export type ReviewAction = 'SUBMIT' | 'REQUEST_CHANGES' | 'REJECT' | 'PUBLISH';

const S = ExaminationStatus;

const TRANSITIONS: Record<
  ReviewAction,
  { from: ExaminationStatus[]; to: ExaminationStatus }
> = {
  SUBMIT: { from: [S.DRAFT, S.CHANGES_REQUESTED], to: S.PENDING_REVIEW },
  REQUEST_CHANGES: { from: [S.PENDING_REVIEW], to: S.CHANGES_REQUESTED },
  REJECT: { from: [S.PENDING_REVIEW], to: S.REJECTED },
  // DRAFT is only publishable when an admin authored it (no teacher proposal to review).
  PUBLISH: { from: [S.PENDING_REVIEW, S.DRAFT], to: S.PUBLISHED },
};

export function nextStatus(
  current: ExaminationStatus,
  action: ReviewAction,
  opts: { teacherAuthored: boolean },
): ExaminationStatus | null {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current)) return null;
  if (action === 'PUBLISH' && current === S.DRAFT && opts.teacherAuthored) {
    return null;
  }
  return rule.to;
}

/** A teacher edits their own proposal only while it is theirs to change. */
export function teacherCanEdit(status: ExaminationStatus): boolean {
  return status === S.DRAFT || status === S.CHANGES_REQUESTED;
}

/** The principal may correct details up to publication, including during review. */
export function adminCanEdit(status: ExaminationStatus): boolean {
  return (
    status === S.DRAFT ||
    status === S.PENDING_REVIEW ||
    status === S.CHANGES_REQUESTED
  );
}

/** Papers are replaced by the author before approval; the principal requests changes instead. */
export function paperIsEditable(status: ExaminationStatus): boolean {
  return teacherCanEdit(status);
}

export function canDelete(
  status: ExaminationStatus,
  hasMarks: boolean,
): boolean {
  return status === S.DRAFT && !hasMarks;
}

export function canEnterMarks(
  status: ExaminationStatus,
  resultStatus: ExaminationResultStatus,
): boolean {
  return (
    status === S.PUBLISHED && resultStatus !== ExaminationResultStatus.FINALIZED
  );
}

export function canFinalize(
  status: ExaminationStatus,
  resultStatus: ExaminationResultStatus,
): boolean {
  return canEnterMarks(status, resultStatus);
}

export function canReopen(resultStatus: ExaminationResultStatus): boolean {
  return resultStatus === ExaminationResultStatus.FINALIZED;
}

export interface SubjectPaperDraft {
  label: string;
  heldAt: Date | null;
  startMin: number | null;
  endMin: number | null;
  maxScore: number | null;
  passingMarks: number | null;
}

export interface ExaminationDraft {
  title: string | null;
  academicYearId: string | null;
  classGradeId: string | null;
  sectionId: string | null;
  termId: string | null;
  subjects: SubjectPaperDraft[];
}

/** The one wording the API and the UI both use when a term is missing. */
export const TERM_REQUIRED_MESSAGE =
  'Please select a term before publishing the exam.';

/**
 * Everything that blocks "Send for Review" (and admin publish). Drafts may be saved
 * incomplete; this is the gate for leaving draft. The exam paper is optional.
 */
export function submissionProblems(
  exam: ExaminationDraft,
  // A principal publishing always needs a term; a teacher only once the session has one.
  opts: { requireTerm?: boolean } = {},
): string[] {
  const problems: string[] = [];
  if (!exam.title?.trim()) problems.push('Examination title is required');
  if (!exam.academicYearId) problems.push('Academic session is required');
  if (!exam.classGradeId) problems.push('Class is required');
  if (!exam.sectionId) problems.push('Section is required');
  if (opts.requireTerm && !exam.termId) problems.push(TERM_REQUIRED_MESSAGE);
  if (exam.subjects.length === 0) problems.push('Add at least one subject');

  for (const s of exam.subjects) {
    const p = s.label;
    if (!s.heldAt) problems.push(`${p}: exam date is required`);
    if (s.maxScore == null || s.maxScore <= 0)
      problems.push(`${p}: total marks must be greater than 0`);
    if (
      s.passingMarks != null &&
      s.maxScore != null &&
      s.passingMarks > s.maxScore
    )
      problems.push(`${p}: passing marks cannot exceed total marks`);
    if (s.startMin != null && s.endMin != null && s.endMin <= s.startMin)
      problems.push(`${p}: end time must be after start time`);
  }
  return problems;
}
