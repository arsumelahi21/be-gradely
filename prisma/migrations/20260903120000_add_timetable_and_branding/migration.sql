-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "PeriodKind" AS ENUM ('CLASS', 'BREAK', 'LUNCH', 'ASSEMBLY', 'FREE');

-- CreateEnum
CREATE TYPE "TimetableStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "logoMimeType" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "photoMimeType" TEXT;

-- CreateTable
CREATE TABLE "SchoolLogo" (
    "schoolId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolLogo_pkey" PRIMARY KEY ("schoolId")
);

-- CreateTable
CREATE TABLE "UserPhoto" (
    "userId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPhoto_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "TimetableConfig" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "workingDays" "DayOfWeek"[],
    "dayStartMin" INTEGER NOT NULL DEFAULT 480,
    "dayEndMin" INTEGER NOT NULL DEFAULT 840,
    "periodMinutes" INTEGER NOT NULL DEFAULT 45,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetablePeriod" (
    "id" TEXT NOT NULL,
    "timetableId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "label" TEXT,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "kind" "PeriodKind" NOT NULL DEFAULT 'CLASS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetablePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Timetable" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "status" "TimetableStatus" NOT NULL DEFAULT 'DRAFT',
    "workingDays" "DayOfWeek"[],
    "dayStartMin" INTEGER NOT NULL DEFAULT 480,
    "dayEndMin" INTEGER NOT NULL DEFAULT 840,
    "periodMinutes" INTEGER NOT NULL DEFAULT 45,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Timetable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableEntry" (
    "id" TEXT NOT NULL,
    "timetableId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "periodId" TEXT NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "sectionSubjectId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "room" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimetableConfig_schoolId_key" ON "TimetableConfig"("schoolId");

-- CreateIndex
CREATE INDEX "TimetablePeriod_timetableId_idx" ON "TimetablePeriod"("timetableId");

-- CreateIndex
CREATE INDEX "TimetablePeriod_schoolId_idx" ON "TimetablePeriod"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetablePeriod_timetableId_index_key" ON "TimetablePeriod"("timetableId", "index");

-- CreateIndex
CREATE INDEX "Timetable_schoolId_status_idx" ON "Timetable"("schoolId", "status");

-- CreateIndex
CREATE INDEX "Timetable_academicYearId_idx" ON "Timetable"("academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "Timetable_sectionId_academicYearId_key" ON "Timetable"("sectionId", "academicYearId");

-- CreateIndex
CREATE INDEX "TimetableEntry_academicYearId_teacherId_dayOfWeek_idx" ON "TimetableEntry"("academicYearId", "teacherId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "TimetableEntry_academicYearId_dayOfWeek_idx" ON "TimetableEntry"("academicYearId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "TimetableEntry_sectionSubjectId_idx" ON "TimetableEntry"("sectionSubjectId");

-- CreateIndex
CREATE INDEX "TimetableEntry_timetableId_idx" ON "TimetableEntry"("timetableId");

-- CreateIndex
CREATE INDEX "TimetableEntry_schoolId_idx" ON "TimetableEntry"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableEntry_timetableId_dayOfWeek_periodId_key" ON "TimetableEntry"("timetableId", "dayOfWeek", "periodId");

-- AddForeignKey
ALTER TABLE "SchoolLogo" ADD CONSTRAINT "SchoolLogo_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPhoto" ADD CONSTRAINT "UserPhoto_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableConfig" ADD CONSTRAINT "TimetableConfig_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetablePeriod" ADD CONSTRAINT "TimetablePeriod_timetableId_fkey" FOREIGN KEY ("timetableId") REFERENCES "Timetable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetablePeriod" ADD CONSTRAINT "TimetablePeriod_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timetable" ADD CONSTRAINT "Timetable_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timetable" ADD CONSTRAINT "Timetable_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timetable" ADD CONSTRAINT "Timetable_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_timetableId_fkey" FOREIGN KEY ("timetableId") REFERENCES "Timetable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "TimetablePeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_sectionSubjectId_fkey" FOREIGN KEY ("sectionSubjectId") REFERENCES "SectionSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

