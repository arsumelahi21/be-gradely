-- Guarded because this index swap is applied by hand (locally, and on live through the
-- lead's workflow) before Prisma records the migration, so `migrate deploy` must not fail.
DROP INDEX IF EXISTS "AcademicYear_code_key";

CREATE UNIQUE INDEX IF NOT EXISTS "AcademicYear_schoolId_code_key" ON "AcademicYear"("schoolId", "code");
