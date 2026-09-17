-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "invigilatorTeacherId" TEXT;

-- CreateIndex
CREATE INDEX "Exam_invigilatorTeacherId_heldAt_idx" ON "Exam"("invigilatorTeacherId", "heldAt");

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_invigilatorTeacherId_fkey" FOREIGN KEY ("invigilatorTeacherId") REFERENCES "TeacherProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
