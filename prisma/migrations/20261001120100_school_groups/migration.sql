-- Guarded so a re-run is a no-op.
CREATE TABLE IF NOT EXISTS "SchoolGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SchoolGroup_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "groupId" TEXT;

CREATE INDEX IF NOT EXISTS "School_groupId_idx" ON "School"("groupId");
CREATE INDEX IF NOT EXISTS "User_groupId_idx" ON "User"("groupId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'School_groupId_fkey') THEN
    ALTER TABLE "School" ADD CONSTRAINT "School_groupId_fkey" FOREIGN KEY ("groupId")
      REFERENCES "SchoolGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_groupId_fkey') THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_groupId_fkey" FOREIGN KEY ("groupId")
      REFERENCES "SchoolGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- Prisma cannot express this, and migrate diff cannot see it: verify via pg_constraint.
  -- A DIRECTOR always has a group and never a school; nobody else has a group.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_director_group_check') THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_director_group_check" CHECK (
      ("role"::text = 'DIRECTOR') = ("groupId" IS NOT NULL)
      AND ("role"::text <> 'DIRECTOR' OR "schoolId" IS NULL));
  END IF;
END $$;
