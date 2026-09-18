// Pure examination lifecycle rules (no Prisma, no I/O) so every transition is unit-tested.
// Values mirror the Prisma enums, which are plain string unions.

import { overlaps } from '../academics/timetable/timetable-time';

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

/** Pinned to a subject row when it belongs to one, so the date sheet can show it beside that row. */
export interface ExamIssue {
  subjectId: string | null;
  message: string;
}

export interface SubjectPaperDraft {
  id: string;
  label: string;
  heldAt: Date | null;
  startMin: number | null;
  endMin: number | null;
  venue: string | null;
  invigilatorTeacherId: string | null;
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
 * Everything that blocks "Send for Review" and, with `forPublish`, publication. Drafts may be
 * saved incomplete. The exam paper is optional; total marks are set later, at marks entry.
 */
export function submissionProblems(
  exam: ExaminationDraft,
  // A principal publishing always needs a term; a teacher only once the session has one.
  opts: { requireTerm?: boolean; forPublish?: boolean } = {},
): ExamIssue[] {
  const issues: ExamIssue[] = [];
  const general = (message: string) =>
    issues.push({ subjectId: null, message });
  if (!exam.title?.trim()) general('Examination title is required');
  if (!exam.academicYearId) general('Academic session is required');
  if (!exam.classGradeId) general('Class is required');
  if (!exam.sectionId) general('Section is required');
  if (opts.requireTerm && !exam.termId) general(TERM_REQUIRED_MESSAGE);
  if (exam.subjects.length === 0) general('Add at least one subject');

  for (const s of exam.subjects) {
    const row = (message: string) =>
      issues.push({ subjectId: s.id, message: `${s.label}: ${message}` });
    if (!s.heldAt) row('exam date is required');
    if (s.maxScore != null && s.maxScore <= 0)
      row('total marks must be greater than 0');
    if (
      s.passingMarks != null &&
      s.maxScore != null &&
      s.passingMarks > s.maxScore
    )
      row('passing marks cannot exceed total marks');
    if (s.startMin != null && s.endMin != null && s.endMin <= s.startMin)
      row('end time must be after start time');
    if (opts.forPublish) {
      if (s.startMin == null) row('start time is required');
      if (s.endMin == null) row('end time is required');
      if (!s.venue?.trim()) row('venue is required');
      if (!s.invigilatorTeacherId) row('invigilator is required');
    }
  }
  return issues;
}

export interface ScheduledPaper {
  id: string;
  label: string;
  heldAt: Date | null;
  startMin: number | null;
  endMin: number | null;
  venue: string | null;
  invigilatorTeacherId: string | null;
  invigilatorName: string | null;
  examinationTitle: string;
  /** section + session: papers sharing it are sat by the same students */
  sectionKey: string;
}

const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const venueKey = (v: string | null) => v?.trim().toLowerCase() || null;

function clash(a: ScheduledPaper, b: ScheduledPaper): boolean {
  return (
    dayOf(a.heldAt) !== null &&
    dayOf(a.heldAt) === dayOf(b.heldAt) &&
    a.startMin != null &&
    a.endMin != null &&
    b.startMin != null &&
    b.endMin != null &&
    overlaps(a.startMin, a.endMin, b.startMin, b.endMin)
  );
}

/**
 * Clashes for one examination's papers: against each other (same students), and against
 * `booked` papers of other published examinations (same invigilator, venue or section).
 * Touching times don't clash — 09:00–11:00 then 11:00–13:00 is allowed.
 */
export function scheduleConflicts(
  own: ScheduledPaper[],
  booked: ScheduledPaper[],
): ExamIssue[] {
  const issues: ExamIssue[] = [];
  for (const p of own) {
    const row = (message: string) =>
      issues.push({ subjectId: p.id, message: `${p.label}: ${message}` });
    for (const q of own) {
      if (q !== p && clash(p, q))
        row(`overlaps ${q.label} — students of this section can't sit both`);
    }
    for (const b of booked) {
      if (!clash(p, b)) continue;
      const other = `${b.label}, ${b.examinationTitle}`;
      if (
        p.invigilatorTeacherId &&
        p.invigilatorTeacherId === b.invigilatorTeacherId
      )
        row(
          `${b.invigilatorName ?? 'This teacher'} is already assigned as an invigilator during this time (${other})`,
        );
      if (venueKey(p.venue) && venueKey(p.venue) === venueKey(b.venue))
        row(
          `${p.venue!.trim()} is already occupied during this time (${other})`,
        );
      if (p.sectionKey === b.sectionKey)
        row(`this section already has ${other} at this time`);
    }
  }
  return issues;
}
