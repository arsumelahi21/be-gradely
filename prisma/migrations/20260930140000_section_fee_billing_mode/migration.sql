-- Fee billing moves from the class to the section, so sections of one class can
-- bill differently. Each section starts with its class's current mode, so no
-- run bills differently the day this applies. No challan, item or payment is
-- touched. Guarded so a replay (restored backup, hand-applied first) is a no-op.

-- Add and copy as one statement, and only when the column is new: a replay
-- after an admin changed a section's mode must not copy the class's over it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Section'
      AND column_name = 'feeBillingMode'
  ) THEN
    ALTER TABLE "Section" ADD COLUMN "feeBillingMode" "FeeBillingMode" NOT NULL DEFAULT 'MONTHLY';
    UPDATE "Section" s
    SET "feeBillingMode" = c."feeBillingMode"
    FROM "ClassGrade" c
    WHERE c."id" = s."classGradeId";
  END IF;
END $$;

-- After the copy: dropping first would reset every by-subject class to monthly.
ALTER TABLE "ClassGrade" DROP COLUMN IF EXISTS "feeBillingMode";
