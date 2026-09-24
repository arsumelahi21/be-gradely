import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

/**
 * Who actually takes a section-subject.
 *
 * Every caller passes the roster IT already resolved — attendance uses ACTIVE
 * only, exams use ACTIVE+COMPLETED minus transfers-out — and these helpers only
 * narrow it. A compulsory offering therefore returns that roster untouched, so a
 * regular class runs exactly the query it ran before this feature existed.
 */

/** Takers of each subject, in two queries whatever the subject count. */
export async function takersBySubject(
  db: Db,
  sectionSubjectIds: string[],
  candidateStudentIds: string[],
  academicYearId: string,
): Promise<Map<string, ReadonlySet<string>>> {
  const takers = new Map<string, Set<string>>();
  if (!sectionSubjectIds.length) return takers;

  const offerings = await db.sectionSubject.findMany({
    where: { id: { in: sectionSubjectIds } },
    select: { id: true, isElective: true },
  });

  // Shared between compulsory subjects; the ReadonlySet return type is what
  // stops a caller mutating one subject's takers into another's.
  const roster = new Set(candidateStudentIds);
  const electiveIds: string[] = [];
  for (const offering of offerings) {
    if (!offering.isElective) {
      takers.set(offering.id, roster);
      continue;
    }
    electiveIds.push(offering.id);
    takers.set(offering.id, new Set());
  }
  // An id with no offering row is left out entirely, so a caller defaulting to
  // an empty set gets nobody rather than the whole class.
  if (!electiveIds.length || !candidateStudentIds.length) return takers;

  const chosen = await db.studentSubject.findMany({
    where: {
      sectionSubjectId: { in: electiveIds },
      academicYearId,
      studentId: { in: candidateStudentIds },
    },
    select: { sectionSubjectId: true, studentId: true },
  });
  for (const row of chosen) {
    takers.get(row.sectionSubjectId)?.add(row.studentId);
  }
  return takers;
}

/** One subject's takers, keeping the caller's ordering. */
export async function narrowToTakers(
  db: Db,
  sectionSubjectId: string,
  candidateStudentIds: string[],
  academicYearId: string,
): Promise<string[]> {
  const takers = (
    await takersBySubject(
      db,
      [sectionSubjectId],
      candidateStudentIds,
      academicYearId,
    )
  ).get(sectionSubjectId);
  if (!takers) return [];
  return candidateStudentIds.filter((id) => takers.has(id));
}

/** The section-subjects one student takes: every compulsory one, plus their own electives. */
export async function subjectsOf(
  db: Db,
  studentId: string,
  sectionId: string,
  academicYearId: string,
): Promise<Set<string>> {
  const offerings = await db.sectionSubject.findMany({
    where: { sectionId },
    select: { id: true, isElective: true },
  });

  const taken = new Set(
    offerings.filter((o) => !o.isElective).map((o) => o.id),
  );
  const electiveIds = offerings.filter((o) => o.isElective).map((o) => o.id);
  if (!electiveIds.length) return taken;

  const chosen = await db.studentSubject.findMany({
    where: { studentId, academicYearId, sectionSubjectId: { in: electiveIds } },
    select: { sectionSubjectId: true },
  });
  for (const row of chosen) taken.add(row.sectionSubjectId);
  return taken;
}

/**
 * The default for a new placement, or for a subject newly opened to student
 * selection: the student takes every selectable subject until an admin unticks
 * it. A regular section has none, so nothing is written for it.
 *
 * A placement that already holds choices (a reactivated one) keeps them rather
 * than having unticked subjects ticked again.
 */
export async function selectAllElectives(
  db: Db,
  placements: {
    studentId: string;
    sectionId: string;
    academicYearId: string;
  }[],
  onlySectionSubjectIds?: string[],
): Promise<void> {
  if (!placements.length) return;
  const offerings = await db.sectionSubject.findMany({
    where: {
      sectionId: { in: [...new Set(placements.map((p) => p.sectionId))] },
      isElective: true,
      ...(onlySectionSubjectIds && { id: { in: onlySectionSubjectIds } }),
    },
    select: {
      id: true,
      sectionId: true,
      section: { select: { schoolId: true } },
    },
  });
  if (!offerings.length) return;

  const sectionOf = new Map(offerings.map((o) => [o.id, o.sectionId]));
  const held = onlySectionSubjectIds
    ? new Set<string>()
    : new Set(
        (
          await db.studentSubject.findMany({
            where: {
              studentId: { in: placements.map((p) => p.studentId) },
              sectionSubjectId: { in: offerings.map((o) => o.id) },
            },
            select: {
              studentId: true,
              sectionSubjectId: true,
              academicYearId: true,
            },
          })
        ).map(
          (r) =>
            `${r.studentId}:${sectionOf.get(r.sectionSubjectId)}:${r.academicYearId}`,
        ),
      );
  await db.studentSubject.createMany({
    data: placements
      .filter(
        (p) => !held.has(`${p.studentId}:${p.sectionId}:${p.academicYearId}`),
      )
      .flatMap((p) =>
        offerings
          .filter((o) => o.sectionId === p.sectionId)
          .map((o) => ({
            schoolId: o.section.schoolId,
            academicYearId: p.academicYearId,
            studentId: p.studentId,
            sectionSubjectId: o.id,
          })),
      ),
    skipDuplicates: true,
  });
}

/** Clears one placement's selections — they describe a section the student is leaving. */
export async function clearSelections(
  db: Db,
  placement: { studentId: string; sectionId: string; academicYearId: string },
): Promise<void> {
  await db.studentSubject.deleteMany({
    where: {
      studentId: placement.studentId,
      academicYearId: placement.academicYearId,
      sectionSubject: { sectionId: placement.sectionId },
    },
  });
}
