import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '../types/role.type';

/**
 * Shared recipient resolution for notification producers — pure functions over
 * PrismaService so services don't re-implement these queries; all return User ids.
 */

/** StudentProfile ids of ACTIVE enrollments in a section. */
export async function sectionStudentIds(
  prisma: PrismaService,
  sectionId: string,
): Promise<string[]> {
  const rows = await prisma.enrollment.findMany({
    where: { sectionId, status: 'ACTIVE' },
    select: { studentId: true },
  });
  return rows.map((r) => r.studentId);
}

/** User ids for the given StudentProfile ids (skips students with no login). */
export async function studentUserIds(
  prisma: PrismaService,
  studentIds: string[],
): Promise<string[]> {
  if (!studentIds.length) return [];
  const rows = await prisma.studentProfile.findMany({
    where: { id: { in: studentIds } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId).filter((id): id is string => !!id);
}

/** User ids of the parents linked to the given StudentProfile ids. */
export async function parentUserIds(
  prisma: PrismaService,
  studentIds: string[],
): Promise<string[]> {
  if (!studentIds.length) return [];
  const rows = await prisma.parentStudent.findMany({
    where: { studentId: { in: studentIds } },
    select: { parent: { select: { userId: true } } },
  });
  return rows.map((r) => r.parent?.userId).filter((id): id is string => !!id);
}

/** User ids of the active SCHOOL_ADMINs of a school. */
export async function schoolAdminUserIds(
  prisma: PrismaService,
  schoolId: string,
): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { role: Role.SCHOOL_ADMIN, schoolId, isActive: true },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * StudentProfile id -> that student's own User id. One query for the whole set;
 * students with no login simply have no entry.
 */
export async function studentUserIdByStudent(
  prisma: PrismaService,
  studentIds: string[],
): Promise<Map<string, string>> {
  if (!studentIds.length) return new Map();
  const rows = await prisma.studentProfile.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, userId: true },
  });
  return new Map(
    rows
      .filter((r): r is { id: string; userId: string } => !!r.userId)
      .map((r) => [r.id, r.userId]),
  );
}

/**
 * StudentProfile id -> the User ids of that student's guardians. One query.
 * The ParentStudent join IS the authorization rule, so a parent can only ever
 * appear against a child they're actually linked to.
 */
export async function parentUserIdsByStudent(
  prisma: PrismaService,
  studentIds: string[],
): Promise<Map<string, string[]>> {
  if (!studentIds.length) return new Map();
  const rows = await prisma.parentStudent.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, parent: { select: { userId: true } } },
  });
  const byStudent = new Map<string, string[]>();
  for (const row of rows) {
    const userId = row.parent?.userId;
    if (!userId) continue;
    byStudent.set(row.studentId, [
      ...(byStudent.get(row.studentId) ?? []),
      userId,
    ]);
  }
  return byStudent;
}

/** Everyone who should hear about ONE student: their login + their guardians. */
export async function studentAudienceUserIds(
  prisma: PrismaService,
  studentId: string,
): Promise<string[]> {
  const [own, parents] = await Promise.all([
    studentUserIdByStudent(prisma, [studentId]),
    parentUserIdsByStudent(prisma, [studentId]),
  ]);
  const self = own.get(studentId);
  return [
    ...new Set([...(self ? [self] : []), ...(parents.get(studentId) ?? [])]),
  ];
}
