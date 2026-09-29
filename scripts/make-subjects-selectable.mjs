/**
 * Every subject becomes student-selectable — "Compulsory" is gone from Section Setup.
 *
 * A selectable subject counts only the students ticked for it, so each compulsory
 * subject is first ticked for every student ever placed in its section, in that
 * placement's own session (current, withdrawn and past). Nobody loses a subject,
 * and past sessions' exams and report cards keep their students. Choices already
 * made on selectable subjects are left alone. Safe to run more than once.
 *
 *   node scripts/make-subjects-selectable.mjs            # dry run — prints the plan
 *   node scripts/make-subjects-selectable.mjs --apply    # writes it, in one transaction
 *
 * Reads DATABASE_URL like every Prisma command: check the target it prints.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

const target = (process.env.DATABASE_URL ?? '').match(/@([^/?]+)\/([^?]+)/);
console.log(`target: ${target ? `${target[1]}/${target[2]}` : 'unknown'}`);

// Each count mirrors the statement it previews: the UPDATE flips every
// compulsory subject, while the INSERT reaches only enrolled students. Counting
// both over one LEFT JOIN promised a tick for every subject in an empty section
// — the row is (NULL, id, NULL), which count(DISTINCT ...) happily counts — so
// the dry run reported more than --apply then wrote.
const [plan] = await prisma.$queryRaw`
  SELECT
    (SELECT count(*)::int FROM "SectionSubject" WHERE "isElective" = false)
      AS subjects,
    (SELECT count(*)::int FROM (
      SELECT DISTINCT e."studentId", ss."id", e."academicYearId"
      FROM "SectionSubject" ss
      JOIN "Enrollment" e ON e."sectionId" = ss."sectionId"
      WHERE ss."isElective" = false
    ) t) AS ticks`;
console.log(
  `${plan.subjects} compulsory subject${plan.subjects === 1 ? '' : 's'} to make selectable · ${plan.ticks} student ticks to add`,
);

if (!apply) {
  console.log('\nDry run — nothing written. Re-run with --apply to write it.');
} else if (plan.subjects > 0) {
  // Locked so an enrolment or a new subject can't land between the ticks and
  // the flip, which would leave that student without the subject.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`LOCK TABLE "Enrollment", "SectionSubject" IN SHARE ROW EXCLUSIVE MODE`;
      const ticked = await tx.$executeRaw`
        INSERT INTO "StudentSubject"
          ("id", "schoolId", "academicYearId", "studentId", "sectionSubjectId", "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, t."schoolId", t."academicYearId", t."studentId", t."sectionSubjectId", now(), now()
        FROM (
          SELECT DISTINCT sec."schoolId", e."academicYearId", e."studentId", ss."id" AS "sectionSubjectId"
          FROM "SectionSubject" ss
          JOIN "Section" sec ON sec."id" = ss."sectionId"
          JOIN "Enrollment" e ON e."sectionId" = ss."sectionId"
          WHERE ss."isElective" = false
        ) t
        ON CONFLICT ("studentId", "sectionSubjectId", "academicYearId") DO NOTHING`;
      const flipped = await tx.$executeRaw`
        UPDATE "SectionSubject" SET "isElective" = true, "updatedAt" = now()
        WHERE "isElective" = false`;
      console.log(
        `\nApplied: ${ticked} ticks added · ${flipped} subjects made selectable.`,
      );
    },
    { timeout: 120_000 },
  );
}

await prisma.$disconnect();
