import { Prisma } from '@prisma/client';

// Roles the app itself stamps on roster rows; a row a human gave any other role is never pruned.
export const SUBJECT_TEACHER_ROLE = 'Subject Teacher';
export const CLASS_TEACHER_ROLE = 'Class Teacher';

/** Rosters a subject's teacher on the section; idempotent, and never downgrades an existing row. */
export async function ensureOnRoster(
  tx: Prisma.TransactionClient,
  sectionId: string,
  teacherId: string,
) {
  await tx.sectionTeacher.upsert({
    where: { sectionId_teacherId: { sectionId, teacherId } },
    create: {
      sectionId,
      teacherId,
      assignmentRole: SUBJECT_TEACHER_ROLE,
      isPrimary: false,
    },
    update: {},
  });
}

/**
 * Drops roster rows nothing backs any more: not the class teacher, an app-stamped role, and no subject
 * taught in the section. Section-wide, so rows orphaned by an earlier write heal on the next one.
 */
export async function pruneSectionRoster(
  tx: Prisma.TransactionClient,
  sectionId: string,
  keepAssignmentId?: string,
) {
  const teaching = await tx.sectionSubject.findMany({
    where: { sectionId, teacherId: { not: null } },
    select: { teacherId: true },
    distinct: ['teacherId'],
  });
  await tx.sectionTeacher.deleteMany({
    where: {
      sectionId,
      isPrimary: false,
      assignmentRole: { in: [SUBJECT_TEACHER_ROLE, CLASS_TEACHER_ROLE] },
      teacherId: {
        notIn: teaching.flatMap((row) =>
          row.teacherId ? [row.teacherId] : [],
        ),
      },
      ...(keepAssignmentId && { id: { not: keepAssignmentId } }),
    },
  });
}
