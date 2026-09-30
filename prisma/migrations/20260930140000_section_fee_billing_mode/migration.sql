-- Fee billing moves from the class to the section, so sections of one class can
-- bill differently. Each section starts with its class's current mode, so no
-- run bills differently the day this applies. No challan, item or payment is
-- touched. Guarded so a replay (restored backup, hand-applied first) is a no-op.

ALTER TABLE "Section" ADD COLUMN IF NOT EXISTS "feeBillingMode" "FeeBillingMode" NOT NULL DEFAULT 'MONTHLY';

-- Copy before the drop: flipping the order would reset every by-subject class
-- to monthly billing without a word.
DO $$ BEGIN
  UPDATE "Section" s
  SET "feeBillingMode" = c."feeBillingMode"
  FROM "ClassGrade" c
  WHERE c."id" = s."classGradeId";
EXCEPTION WHEN undefined_column THEN NULL; -- replayed after the drop: already copied
END $$;

ALTER TABLE "ClassGrade" DROP COLUMN IF EXISTS "feeBillingMode";
