import { Prisma } from '@prisma/client';

// Response shapes per audience. Staff and students get separate selects AND separate
// mappers, so paper metadata can't reach a student even if a select grows.

export const schoolHeaderSelect = {
  id: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  country: true,
  phone: true,
  email: true,
  logoMimeType: true,
} satisfies Prisma.SchoolSelect;

export const staffExaminationInclude = {
  school: { select: schoolHeaderSelect },
  academicYear: {
    select: { id: true, name: true, startDate: true, endDate: true },
  },
  term: { select: { id: true, name: true } },
  gradingScheme: { select: { id: true, name: true } },
  createdByTeacher: { select: { id: true, fullName: true } },
  createdByUser: { select: { id: true, fullName: true, role: true } },
  reviewedByUser: { select: { id: true, fullName: true } },
  finalizedByUser: { select: { id: true, fullName: true } },
  subjects: {
    orderBy: [{ heldAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      title: true,
      description: true,
      heldAt: true,
      startMin: true,
      endMin: true,
      venue: true,
      maxScore: true,
      passingMarks: true,
      createdByTeacherId: true,
      invigilator: { select: { id: true, fullName: true } },
      sectionSubject: {
        select: {
          id: true,
          teacherId: true,
          subject: { select: { id: true, name: true, code: true } },
          teacher: { select: { id: true, fullName: true } },
        },
      },
      // Never select `data` here — bytes leave only through the paper endpoint.
      paper: { select: { fileName: true, sizeBytes: true, uploadedAt: true } },
      _count: { select: { results: true } },
    },
  },
} satisfies Prisma.ExaminationInclude;

export type StaffExaminationRow = Prisma.ExaminationGetPayload<{
  include: typeof staffExaminationInclude;
}>;

export function toStaffExamination(row: StaffExaminationRow) {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    resultStatus: row.resultStatus,
    reviewNote: row.reviewNote,
    className: row.className,
    sectionName: row.sectionName,
    academicYearId: row.academicYearId,
    classGradeId: row.classGradeId,
    sectionId: row.sectionId,
    termId: row.termId,
    gradingSchemeId: row.gradingSchemeId,
    school: row.school,
    academicYear: row.academicYear,
    term: row.term,
    gradingScheme: row.gradingScheme,
    createdBy: {
      teacherId: row.createdByTeacherId,
      name:
        row.createdByTeacher?.fullName ?? row.createdByUser?.fullName ?? null,
      role: row.createdByUser?.role ?? null,
    },
    reviewedBy: row.reviewedByUser
      ? { name: row.reviewedByUser.fullName }
      : null,
    finalizedBy: row.finalizedByUser
      ? { name: row.finalizedByUser.fullName }
      : null,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    publishedAt: row.publishedAt,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    subjects: row.subjects.map((s) => ({
      id: s.id,
      sectionSubjectId: s.sectionSubject.id,
      subject: s.sectionSubject.subject,
      teacher: s.sectionSubject.teacher,
      heldAt: s.heldAt,
      startMin: s.startMin,
      endMin: s.endMin,
      venue: s.venue,
      invigilator: s.invigilator,
      maxScore: s.maxScore,
      passingMarks: s.passingMarks,
      description: s.description,
      hasPaper: !!s.paper,
      paper: s.paper
        ? {
            fileName: s.paper.fileName,
            sizeBytes: s.paper.sizeBytes,
            uploadedAt: s.paper.uploadedAt,
          }
        : null,
      marksEntered: s._count.results,
    })),
  };
}

export const audienceExaminationSelect = {
  id: true,
  title: true,
  instructions: true,
  status: true,
  resultStatus: true,
  publishedAt: true,
  finalizedAt: true,
  className: true,
  sectionName: true,
  academicYear: { select: { id: true, name: true } },
  term: { select: { id: true, name: true } },
  subjects: {
    orderBy: [{ heldAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      heldAt: true,
      startMin: true,
      endMin: true,
      venue: true,
      maxScore: true,
      passingMarks: true,
      sectionSubject: {
        select: { subject: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.ExaminationSelect;

export type AudienceExaminationRow = Prisma.ExaminationGetPayload<{
  select: typeof audienceExaminationSelect;
}>;

/** Students and parents get examination information only — an explicit whitelist, no paper data. */
export function toAudienceExamination(row: AudienceExaminationRow) {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    resultStatus: row.resultStatus,
    resultAvailable: row.resultStatus === 'FINALIZED',
    publishedAt: row.publishedAt,
    finalizedAt: row.resultStatus === 'FINALIZED' ? row.finalizedAt : null,
    className: row.className,
    sectionName: row.sectionName,
    academicYear: row.academicYear
      ? { id: row.academicYear.id, name: row.academicYear.name }
      : null,
    term: row.term ? { id: row.term.id, name: row.term.name } : null,
    subjects: row.subjects.map((s) => ({
      id: s.id,
      subject: {
        id: s.sectionSubject.subject.id,
        name: s.sectionSubject.subject.name,
      },
      heldAt: s.heldAt,
      startMin: s.startMin,
      endMin: s.endMin,
      venue: s.venue,
      maxScore: s.maxScore,
      passingMarks: s.passingMarks,
    })),
  };
}

export function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function formatMinutes(min: number | null | undefined): string | null {
  if (min == null) return null;
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Exam dates are stored as UTC midnight, so format in UTC to avoid off-by-one days. */
export function formatDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Strips path parts and header-breaking characters; always ends in .pdf. */
export function safePaperFileName(original: string | null | undefined): string {
  const base = (original ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base
    .replace(/\.pdf$/i, '')
    .replace(/[^\w .()-]/g, '_')
    .trim()
    .slice(0, 100);
  return `${stem || 'exam-paper'}.pdf`;
}
