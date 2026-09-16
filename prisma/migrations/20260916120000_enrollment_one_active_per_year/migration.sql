-- Partial unique index: Prisma cannot express one, so it lives only here — `migrate diff`
-- can't see it either, which is why the CI drift gate stays green without a schema change.
-- Close existing duplicates first (`node scripts/dedupe-enrollments.mjs --apply`), or this fails.
CREATE UNIQUE INDEX IF NOT EXISTS "Enrollment_one_active_per_year"
  ON "Enrollment"("studentId", "academicYearId")
  WHERE "status" = 'ACTIVE';
