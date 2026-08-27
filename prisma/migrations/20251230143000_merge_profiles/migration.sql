-- Allow TeacherProfile and StudentProfile to own full academic data
ALTER TABLE "TeacherProfile"
  ADD COLUMN "schoolId" TEXT,
  ADD COLUMN "employeeCode" TEXT,
  ADD COLUMN "designation" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "hireDate" TIMESTAMP(3),
  ADD COLUMN "about" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeacherProfile"
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "StudentProfile"
  ADD COLUMN "schoolId" TEXT,
  ADD COLUMN "admissionNo" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "dateOfJoining" TIMESTAMP(3),
  ADD COLUMN "address" TEXT,
  ADD COLUMN "guardianName" TEXT,
  ADD COLUMN "guardianPhone" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "StudentProfile"
  ALTER COLUMN "userId" DROP NOT NULL;

-- Drop foreign keys that pointed to the legacy Student / Teacher tables
ALTER TABLE "Enrollment" DROP CONSTRAINT IF EXISTS "Enrollment_studentId_fkey";
ALTER TABLE "SectionSubject" DROP CONSTRAINT IF EXISTS "SectionSubject_teacherId_fkey";
ALTER TABLE "TeacherQualification" DROP CONSTRAINT IF EXISTS "TeacherQualification_teacherId_fkey";
ALTER TABLE "TeacherSubjectSpecialty" DROP CONSTRAINT IF EXISTS "TeacherSubjectSpecialty_teacherId_fkey";

-- Merge Teacher table data into TeacherProfile
UPDATE "TeacherProfile" tp
SET
  "schoolId" = t."schoolId",
  "fullName" = COALESCE(t."fullName", tp."fullName"),
  "employeeCode" = COALESCE(t."employeeCode", tp."employeeCode"),
  "designation" = COALESCE(t."designation", tp."designation"),
  "email" = COALESCE(t."email", tp."email"),
  "phone" = COALESCE(t."phone", tp."phone"),
  "hireDate" = COALESCE(t."hireDate", tp."hireDate"),
  "about" = COALESCE(t."about", tp."about"),
  "isActive" = COALESCE(t."isActive", tp."isActive"),
  "createdAt" = COALESCE(tp."createdAt", t."createdAt", CURRENT_TIMESTAMP),
  "updatedAt" = COALESCE(tp."updatedAt", t."updatedAt", CURRENT_TIMESTAMP)
FROM "Teacher" t
WHERE t."userId" IS NOT NULL AND tp."userId" = t."userId";

INSERT INTO "TeacherProfile" ("id","userId","schoolId","fullName","employeeCode","designation","email","phone","hireDate","about","isActive","createdAt","updatedAt")
SELECT t."id", t."userId", t."schoolId", t."fullName", t."employeeCode", t."designation", t."email", t."phone", t."hireDate", t."about", t."isActive", t."createdAt", t."updatedAt"
FROM "Teacher" t
WHERE t."userId" IS NULL OR NOT EXISTS (SELECT 1 FROM "TeacherProfile" tp WHERE tp."userId" = t."userId");

-- Make sure all remaining teacher profiles have a schoolId (derived from the linked user when needed)
UPDATE "TeacherProfile" tp
SET "schoolId" = u."schoolId"
FROM "User" u
WHERE tp."schoolId" IS NULL AND tp."userId" = u."id";

-- Merge Student table data into StudentProfile
UPDATE "StudentProfile" sp
SET
  "schoolId" = s."schoolId",
  "fullName" = COALESCE(s."fullName", sp."fullName"),
  "rollNo" = COALESCE(s."rollNo", sp."rollNo"),
  "admissionNo" = COALESCE(s."admissionNo", sp."admissionNo"),
  "email" = COALESCE(s."email", sp."email"),
  "phone" = COALESCE(s."phone", sp."phone"),
  "dob" = COALESCE(s."dob", sp."dob"),
  "dateOfJoining" = COALESCE(s."dateOfJoining", sp."dateOfJoining"),
  "address" = COALESCE(s."address", sp."address"),
  "guardianName" = COALESCE(s."guardianName", sp."guardianName"),
  "guardianPhone" = COALESCE(s."guardianPhone", sp."guardianPhone"),
  "isActive" = COALESCE(s."isActive", sp."isActive"),
  "createdAt" = COALESCE(sp."createdAt", s."createdAt", CURRENT_TIMESTAMP),
  "updatedAt" = COALESCE(sp."updatedAt", s."updatedAt", CURRENT_TIMESTAMP)
FROM "Student" s
WHERE s."userId" IS NOT NULL AND sp."userId" = s."userId";

INSERT INTO "StudentProfile" ("id","userId","schoolId","fullName","rollNo","admissionNo","email","phone","dob","dateOfJoining","address","guardianName","guardianPhone","isActive","createdAt","updatedAt")
SELECT s."id", s."userId", s."schoolId", s."fullName", s."rollNo", s."admissionNo", s."email", s."phone", s."dob", s."dateOfJoining", s."address", s."guardianName", s."guardianPhone", s."isActive", s."createdAt", s."updatedAt"
FROM "Student" s
WHERE s."userId" IS NULL OR NOT EXISTS (SELECT 1 FROM "StudentProfile" sp WHERE sp."userId" = s."userId");

-- Fill in schoolId for any remaining student profiles via the linked user
UPDATE "StudentProfile" sp
SET "schoolId" = u."schoolId"
FROM "User" u
WHERE sp."schoolId" IS NULL AND sp."userId" = u."id";

-- Point existing enrollments and teaching assignments at the profile tables
UPDATE "SectionSubject" ss
SET "teacherId" = tp."id"
FROM "Teacher" t
JOIN "TeacherProfile" tp ON tp."userId" = t."userId"
WHERE ss."teacherId" = t."id";

UPDATE "TeacherQualification" tq
SET "teacherId" = tp."id"
FROM "Teacher" t
JOIN "TeacherProfile" tp ON tp."userId" = t."userId"
WHERE tq."teacherId" = t."id";

UPDATE "TeacherSubjectSpecialty" ts
SET "teacherId" = tp."id"
FROM "Teacher" t
JOIN "TeacherProfile" tp ON tp."userId" = t."userId"
WHERE ts."teacherId" = t."id";

UPDATE "Enrollment" e
SET "studentId" = sp."id"
FROM "Student" s
JOIN "StudentProfile" sp ON sp."userId" = s."userId"
WHERE e."studentId" = s."id";

-- Enforce NOT NULL on the new schoolId columns
ALTER TABLE "TeacherProfile" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "StudentProfile" ALTER COLUMN "schoolId" SET NOT NULL;

-- Add foreign keys/indexes for the updated schema
ALTER TABLE "TeacherProfile"
  ADD CONSTRAINT "TeacherProfile_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "TeacherProfile_schoolId_employeeCode_key" ON "TeacherProfile"("schoolId","employeeCode");
CREATE INDEX IF NOT EXISTS "TeacherProfile_schoolId_idx" ON "TeacherProfile"("schoolId");

ALTER TABLE "StudentProfile"
  ADD CONSTRAINT "StudentProfile_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "StudentProfile_schoolId_admissionNo_key" ON "StudentProfile"("schoolId","admissionNo");
CREATE INDEX IF NOT EXISTS "StudentProfile_schoolId_idx" ON "StudentProfile"("schoolId");

-- Re-create foreign keys pointing at the profile tables
ALTER TABLE "Enrollment"
  ADD CONSTRAINT "Enrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SectionSubject"
  ADD CONSTRAINT "SectionSubject_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TeacherQualification"
  ADD CONSTRAINT "TeacherQualification_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherSubjectSpecialty"
  ADD CONSTRAINT "TeacherSubjectSpecialty_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop legacy tables now that the data lives on the profile models
DROP TABLE IF EXISTS "Student";
DROP TABLE IF EXISTS "Teacher";
