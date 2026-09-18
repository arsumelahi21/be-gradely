import {
  Exam,
  ExaminationResultStatus,
  ExaminationStatus,
} from '@prisma/client';
import { prisma } from './db';

/** Writes an Examination with one subject paper per section-subject directly, for test setup. */
export async function seedExamination(opts: {
  schoolId: string;
  academicYearId: string;
  sectionId: string;
  sectionSubjectIds: string[];
  title?: string;
  status?: ExaminationStatus;
  resultStatus?: ExaminationResultStatus;
  createdByTeacherId?: string | null;
  createdByUserId?: string | null;
  maxScore?: number | null;
  passingMarks?: number | null;
  heldAt?: Date | null;
  termId?: string | null;
  invigilatorTeacherId?: string | null;
}) {
  const section = await prisma.section.findUniqueOrThrow({
    where: { id: opts.sectionId },
    include: { classGrade: true },
  });
  const status = opts.status ?? 'PUBLISHED';
  const resultStatus = opts.resultStatus ?? 'NOT_STARTED';
  const examination = await prisma.examination.create({
    data: {
      schoolId: opts.schoolId,
      academicYearId: opts.academicYearId,
      classGradeId: section.classGradeId,
      sectionId: section.id,
      termId: opts.termId ?? null,
      title: opts.title ?? 'Mid Term Examination',
      status,
      resultStatus,
      className: section.classGrade.name,
      sectionName: section.name,
      createdByTeacherId: opts.createdByTeacherId ?? null,
      createdByUserId: opts.createdByUserId ?? null,
      publishedAt: status === 'PUBLISHED' ? new Date() : null,
      finalizedAt: resultStatus === 'FINALIZED' ? new Date() : null,
    },
  });
  const subjects: Exam[] = [];
  for (const sectionSubjectId of opts.sectionSubjectIds) {
    subjects.push(
      await prisma.exam.create({
        data: {
          schoolId: opts.schoolId,
          academicYearId: opts.academicYearId,
          examinationId: examination.id,
          sectionSubjectId,
          createdByTeacherId: opts.createdByTeacherId ?? null,
          title: 'Subject paper',
          maxScore: opts.maxScore === undefined ? 100 : opts.maxScore,
          passingMarks:
            opts.passingMarks === undefined ? 40 : opts.passingMarks,
          heldAt:
            opts.heldAt === undefined ? new Date('2026-10-12') : opts.heldAt,
          startMin: 540,
          endMin: 660,
          venue: 'Hall 1',
          invigilatorTeacherId: opts.invigilatorTeacherId ?? null,
        },
      }),
    );
  }
  return { examination, subjects };
}
