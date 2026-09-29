import { PrismaService } from '../../prisma/prisma.service';
import { crossSectionTakers } from '../../academics/section-subjects/subject-takers';

/**
 * A teacher's student visibility, resolved the same way TeachersService
 * computes it: the UNION of SectionTeacher (class teacher) and
 * SectionSubject.teacherId (subject teacher) -> sections -> ACTIVE enrollments.
 *
 * Shared so read-scoping isn't reimplemented per feature and can't drift.
 */

export async function resolveTeacherSectionIds(
  prisma: PrismaService,
  teacherProfileId: string,
): Promise<string[]> {
  const [asClassTeacher, asSubjectTeacher] = await Promise.all([
    prisma.sectionTeacher.findMany({
      where: { teacherId: teacherProfileId },
      select: { sectionId: true },
    }),
    prisma.sectionSubject.findMany({
      where: { teacherId: teacherProfileId },
      select: { sectionId: true },
    }),
  ]);
  return [
    ...new Set([
      ...asClassTeacher.map((s) => s.sectionId),
      ...asSubjectTeacher.map((s) => s.sectionId),
    ]),
  ];
}

export async function resolveTeacherStudentIds(
  prisma: PrismaService,
  teacherProfileId: string,
): Promise<string[]> {
  const sectionIds = await resolveTeacherSectionIds(prisma, teacherProfileId);
  if (!sectionIds.length) return [];
  const [enrollments, running] = await Promise.all([
    prisma.enrollment.findMany({
      where: { sectionId: { in: sectionIds }, status: 'ACTIVE' },
      select: { studentId: true },
    }),
    // The sessions these classes run now — a section may itself be empty and
    // hold only students picking in from its siblings.
    prisma.enrollment.findMany({
      where: {
        status: 'ACTIVE',
        section: {
          classGrade: { sections: { some: { id: { in: sectionIds } } } },
        },
      },
      select: { academicYearId: true },
      distinct: ['academicYearId'],
    }),
  ]);
  // Students placed in a sibling section who take one of these sections'
  // subjects — the same takers the sections' attendance and exam sheets list.
  const offerings = await prisma.sectionSubject.findMany({
    where: { sectionId: { in: sectionIds } },
    select: { id: true },
  });
  const picks = await Promise.all(
    running.map((r) =>
      crossSectionTakers(
        prisma,
        offerings.map((o) => o.id),
        r.academicYearId,
      ),
    ),
  );
  return [
    ...new Set([...enrollments.map((e) => e.studentId), ...picks.flat()]),
  ];
}

export async function resolveTeacherProfileId(
  prisma: PrismaService,
  userId: string,
): Promise<string | null> {
  const profile = await prisma.teacherProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}
