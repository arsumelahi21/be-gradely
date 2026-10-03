-- One director per school group (SchoolGroup.directorId) instead of User.groupId, so one
-- user can direct several groups; and at most one active principal per school.

-- 1. Each group's director moves onto the group: the earliest-created of its directors.
ALTER TABLE "SchoolGroup" ADD COLUMN "directorId" TEXT;

UPDATE "SchoolGroup" g
   SET "directorId" = (SELECT u."id" FROM "User" u
                        WHERE u."groupId" = g."id" AND u."role" = 'DIRECTOR'
                        ORDER BY u."createdAt", u."id" LIMIT 1);

-- Fails here, leaving nothing half-done, if a group has no director: assign one first.
ALTER TABLE "SchoolGroup" ALTER COLUMN "directorId" SET NOT NULL;

CREATE INDEX "SchoolGroup_directorId_idx" ON "SchoolGroup"("directorId");

ALTER TABLE "SchoolGroup" ADD CONSTRAINT "SchoolGroup_directorId_fkey" FOREIGN KEY ("directorId")
  REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. User.groupId goes, with the CHECK that tied it to the DIRECTOR role.
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_director_group_check";
ALTER TABLE "User" DROP CONSTRAINT "User_groupId_fkey";
DROP INDEX "User_groupId_idx";
ALTER TABLE "User" DROP COLUMN "groupId";

-- Prisma cannot express this, and migrate diff cannot see it: verify via pg_constraint.
-- A director oversees groups, never one school.
ALTER TABLE "User" ADD CONSTRAINT "User_director_school_check"
  CHECK ("role" <> 'DIRECTOR' OR "schoolId" IS NULL);

-- 3. One active principal per school. Deactivated principals stay as history.
-- Partial index: invisible to migrate diff, verify via pg_indexes. The predicate compares the
-- enum itself: a ::text cast is not IMMUTABLE, which an index predicate requires. On a database that
-- already has two active principals in one school this fails; check first (read-only):
--   SELECT "schoolId", COUNT(*) FROM "User"
--    WHERE "role" = 'SCHOOL_ADMIN' AND "isActive" GROUP BY 1 HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX "User_one_active_principal_per_school"
  ON "User"("schoolId") WHERE "role" = 'SCHOOL_ADMIN' AND "isActive";
