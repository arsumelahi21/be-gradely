-- Subject-based fees. Additive only: every existing class becomes MONTHLY, so
-- challan generation is unchanged; no existing challan, item or payment is
-- touched, and no subject code gets a fee until the principal sets one.
-- Guarded so a replay (restored backup, hand-applied first) is a no-op.

DO $$ BEGIN
  CREATE TYPE "FeeBillingMode" AS ENUM ('MONTHLY', 'SUBJECT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ChallanItem" ADD COLUMN IF NOT EXISTS "subjectId" TEXT;

ALTER TABLE "ClassGrade" ADD COLUMN IF NOT EXISTS "feeBillingMode" "FeeBillingMode" NOT NULL DEFAULT 'MONTHLY';

CREATE TABLE IF NOT EXISTS "SubjectFee" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubjectFee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SubjectFee_schoolId_code_key" ON "SubjectFee"("schoolId", "code");

CREATE INDEX IF NOT EXISTS "ChallanItem_subjectId_idx" ON "ChallanItem"("subjectId");

DO $$ BEGIN
  ALTER TABLE "SubjectFee" ADD CONSTRAINT "SubjectFee_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ChallanItem" ADD CONSTRAINT "ChallanItem_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
