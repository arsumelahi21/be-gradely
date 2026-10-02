-- KNOWN_ISSUES #82: a month whose challan an admin cancelled can be billed again.
-- One live challan per student and month is still a database rule, but a challan
-- cancelled by an admin no longer holds the month. One whose balance was carried
-- into a later challan as arrears still does, or that debt would be billed twice:
-- generation now records that link in "supersededById" instead of only in the
-- cancel reason. Guarded so a replay (hand-applied first) is a no-op.

ALTER TABLE "Challan" ADD COLUMN IF NOT EXISTS "supersededById" TEXT;

DO $$ BEGIN
  ALTER TABLE "Challan" ADD CONSTRAINT "Challan_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Challan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Challans carried forward before this migration carry the link only as text.
UPDATE "Challan" c
SET "supersededById" = a."id"
FROM "Challan" a
WHERE c."status" = 'CANCELLED'
  AND c."supersededById" IS NULL
  AND a."schoolId" = c."schoolId"
  AND a."studentId" = c."studentId"
  AND c."cancelReason" = 'Carried forward to ' || a."challanNo";

CREATE INDEX IF NOT EXISTS "Challan_studentId_academicYearId_periodYear_periodMonth_idx" ON "Challan"("studentId", "academicYearId", "periodYear", "periodMonth");

-- Partial, so invisible to `prisma migrate diff`; check pg_indexes, not the diff.
CREATE UNIQUE INDEX IF NOT EXISTS "Challan_one_live_per_month" ON "Challan"("studentId", "academicYearId", "periodYear", "periodMonth") WHERE "status" <> 'CANCELLED' OR "supersededById" IS NOT NULL;

DROP INDEX IF EXISTS "Challan_studentId_academicYearId_periodYear_periodMonth_key";
