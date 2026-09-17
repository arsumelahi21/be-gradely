-- CreateEnum
CREATE TYPE "ExaminationStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'CHANGES_REQUESTED', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExaminationResultStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'FINALIZED');

-- CreateEnum
CREATE TYPE "ExaminationEventType" AS ENUM ('CREATED', 'UPDATED', 'ADMIN_EDITED', 'SUBJECT_ADDED', 'SUBJECT_UPDATED', 'SUBJECT_REMOVED', 'PAPER_UPLOADED', 'PAPER_REMOVED', 'SUBMITTED', 'CHANGES_REQUESTED', 'REJECTED', 'PUBLISHED', 'MARKS_SAVED', 'REMARKS_UPDATED', 'RESULTS_FINALIZED', 'RESULTS_REOPENED');

-- CreateTable
CREATE TABLE "Examination" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "classGradeId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "termId" TEXT,
    "gradingSchemeId" TEXT,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "status" "ExaminationStatus" NOT NULL DEFAULT 'DRAFT',
    "resultStatus" "ExaminationResultStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "reviewNote" TEXT,
    "className" TEXT NOT NULL,
    "sectionName" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdByTeacherId" TEXT,
    "reviewedByUserId" TEXT,
    "finalizedByUserId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Examination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamPaper" (
    "examId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamPaper_pkey" PRIMARY KEY ("examId")
);

-- CreateTable
CREATE TABLE "ExaminationResult" (
    "id" TEXT NOT NULL,
    "examinationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "totalObtained" INTEGER,
    "totalMax" INTEGER,
    "percentage" DOUBLE PRECISION,
    "grade" TEXT,
    "passed" BOOLEAN,
    "position" INTEGER,
    "classTeacherRemarks" TEXT,
    "principalRemarks" TEXT,
    "studentName" TEXT,
    "rollNo" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExaminationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExaminationEvent" (
    "id" TEXT NOT NULL,
    "examinationId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" "ExaminationEventType" NOT NULL,
    "fromStatus" "ExaminationStatus",
    "toStatus" "ExaminationStatus",
    "reason" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExaminationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademicTerm" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademicTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradingScheme" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GradingScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeBand" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minPercent" INTEGER NOT NULL,
    "isPassing" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT,

    CONSTRAINT "GradeBand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Examination_schoolId_academicYearId_status_idx" ON "Examination"("schoolId", "academicYearId", "status");

-- CreateIndex
CREATE INDEX "Examination_schoolId_status_submittedAt_idx" ON "Examination"("schoolId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "Examination_sectionId_academicYearId_status_idx" ON "Examination"("sectionId", "academicYearId", "status");

-- CreateIndex
CREATE INDEX "Examination_createdByTeacherId_status_idx" ON "Examination"("createdByTeacherId", "status");

-- CreateIndex
CREATE INDEX "Examination_termId_idx" ON "Examination"("termId");

-- CreateIndex
CREATE INDEX "ExamPaper_schoolId_idx" ON "ExamPaper"("schoolId");

-- CreateIndex
CREATE INDEX "ExaminationResult_studentId_idx" ON "ExaminationResult"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExaminationResult_examinationId_studentId_key" ON "ExaminationResult"("examinationId", "studentId");

-- CreateIndex
CREATE INDEX "ExaminationEvent_examinationId_createdAt_idx" ON "ExaminationEvent"("examinationId", "createdAt");

-- CreateIndex
CREATE INDEX "AcademicTerm_schoolId_academicYearId_idx" ON "AcademicTerm"("schoolId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicTerm_academicYearId_name_key" ON "AcademicTerm"("academicYearId", "name");

-- CreateIndex
CREATE INDEX "GradingScheme_schoolId_idx" ON "GradingScheme"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "GradingScheme_schoolId_name_key" ON "GradingScheme"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GradeBand_schemeId_minPercent_key" ON "GradeBand"("schemeId", "minPercent");

-- CreateIndex
CREATE UNIQUE INDEX "GradeBand_schemeId_label_key" ON "GradeBand"("schemeId", "label");

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_classGradeId_fkey" FOREIGN KEY ("classGradeId") REFERENCES "ClassGrade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_termId_fkey" FOREIGN KEY ("termId") REFERENCES "AcademicTerm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_gradingSchemeId_fkey" FOREIGN KEY ("gradingSchemeId") REFERENCES "GradingScheme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_createdByTeacherId_fkey" FOREIGN KEY ("createdByTeacherId") REFERENCES "TeacherProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examination" ADD CONSTRAINT "Examination_finalizedByUserId_fkey" FOREIGN KEY ("finalizedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradingScheme" ADD CONSTRAINT "GradingScheme_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeBand" ADD CONSTRAINT "GradeBand_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "GradingScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExaminationResult" ADD CONSTRAINT "ExaminationResult_examinationId_fkey" FOREIGN KEY ("examinationId") REFERENCES "Examination"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExaminationResult" ADD CONSTRAINT "ExaminationResult_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExaminationEvent" ADD CONSTRAINT "ExaminationEvent_examinationId_fkey" FOREIGN KEY ("examinationId") REFERENCES "Examination"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExaminationEvent" ADD CONSTRAINT "ExaminationEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "Exam" DROP CONSTRAINT "Exam_academicYearId_fkey";

-- DropForeignKey
ALTER TABLE "Exam" DROP CONSTRAINT "Exam_createdByTeacherId_fkey";

-- DropForeignKey
ALTER TABLE "Exam" DROP CONSTRAINT "Exam_sectionSubjectId_fkey";

-- DropForeignKey
ALTER TABLE "ExamResult" DROP CONSTRAINT "ExamResult_studentId_fkey";

-- AlterTable: examinationId is added NULLABLE so existing rows can be backfilled below.
ALTER TABLE "Exam" ADD COLUMN     "endMin" INTEGER,
ADD COLUMN     "examinationId" TEXT,
ADD COLUMN     "passingMarks" INTEGER,
ADD COLUMN     "startMin" INTEGER,
ADD COLUMN     "venue" TEXT,
ALTER COLUMN "createdByTeacherId" DROP NOT NULL;

-- Backfill: one Examination per existing Exam, reusing the exam's own id so the link below
-- needs no bookkeeping. Class and section are derived through SectionSubject; className and
-- sectionName are NOT NULL snapshots on the new model. The old ExamStatus is dropped further
-- down, so map it here: DRAFT stays DRAFT, PUBLISHED and CLOSED both become PUBLISHED —
-- ExaminationStatus has no closed state, so that distinction is not preserved.
INSERT INTO "Examination" (
    "id", "schoolId", "academicYearId", "classGradeId", "sectionId",
    "title", "status", "resultStatus", "className", "sectionName",
    "createdByTeacherId", "publishedAt", "createdAt", "updatedAt"
)
SELECT
    e."id",
    e."schoolId",
    e."academicYearId",
    s."classGradeId",
    s."id",
    e."title",
    CASE WHEN e."status" = 'DRAFT' THEN 'DRAFT'::"ExaminationStatus" ELSE 'PUBLISHED'::"ExaminationStatus" END,
    'NOT_STARTED'::"ExaminationResultStatus",
    cg."name",
    s."name",
    e."createdByTeacherId",
    CASE WHEN e."status" = 'DRAFT' THEN NULL ELSE e."createdAt" END,
    e."createdAt",
    e."updatedAt"
FROM "Exam" e
JOIN "SectionSubject" ss ON ss."id" = e."sectionSubjectId"
JOIN "Section" s ON s."id" = ss."sectionId"
JOIN "ClassGrade" cg ON cg."id" = s."classGradeId";

-- Link each exam to the examination created for it.
UPDATE "Exam" SET "examinationId" = "id" WHERE "examinationId" IS NULL;

-- Now the column can carry the constraint the model declares.
ALTER TABLE "Exam" ALTER COLUMN "examinationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Exam" DROP COLUMN "status";

-- AlterTable
ALTER TABLE "ExamResult" ADD COLUMN     "enteredByUserId" TEXT,
ADD COLUMN     "isAbsent" BOOLEAN NOT NULL DEFAULT false;

-- DropEnum
DROP TYPE "ExamStatus";

-- CreateIndex
CREATE INDEX "Exam_heldAt_idx" ON "Exam"("heldAt");

-- CreateIndex
CREATE UNIQUE INDEX "Exam_examinationId_sectionSubjectId_key" ON "Exam"("examinationId", "sectionSubjectId");

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_examinationId_fkey" FOREIGN KEY ("examinationId") REFERENCES "Examination"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_sectionSubjectId_fkey" FOREIGN KEY ("sectionSubjectId") REFERENCES "SectionSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_createdByTeacherId_fkey" FOREIGN KEY ("createdByTeacherId") REFERENCES "TeacherProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamPaper" ADD CONSTRAINT "ExamPaper_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
