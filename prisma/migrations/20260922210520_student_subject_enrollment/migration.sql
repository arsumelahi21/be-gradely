-- AlterTable
ALTER TABLE "SectionSubject" ADD COLUMN     "isElective" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "StudentSubject" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sectionSubjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentSubject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentSubject_sectionSubjectId_academicYearId_idx" ON "StudentSubject"("sectionSubjectId", "academicYearId");

-- CreateIndex
CREATE INDEX "StudentSubject_studentId_academicYearId_idx" ON "StudentSubject"("studentId", "academicYearId");

-- CreateIndex
CREATE INDEX "StudentSubject_schoolId_idx" ON "StudentSubject"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentSubject_studentId_sectionSubjectId_academicYearId_key" ON "StudentSubject"("studentId", "sectionSubjectId", "academicYearId");

-- AddForeignKey
ALTER TABLE "StudentSubject" ADD CONSTRAINT "StudentSubject_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubject" ADD CONSTRAINT "StudentSubject_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubject" ADD CONSTRAINT "StudentSubject_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubject" ADD CONSTRAINT "StudentSubject_sectionSubjectId_fkey" FOREIGN KEY ("sectionSubjectId") REFERENCES "SectionSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
