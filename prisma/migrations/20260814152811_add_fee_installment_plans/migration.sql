-- CreateEnum
CREATE TYPE "InstallmentIntervalUnit" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "installmentReminderDaysBefore" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "installmentReminderEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "FeeInstallmentPlan" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "intervalUnit" "InstallmentIntervalUnit",
    "intervalCount" INTEGER,
    "startDate" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeInstallmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeInstallment" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "reminderSentAt" TIMESTAMP(3),

    CONSTRAINT "FeeInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeeInstallmentPlan_schoolId_isActive_idx" ON "FeeInstallmentPlan"("schoolId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "FeeInstallmentPlan_studentId_academicYearId_key" ON "FeeInstallmentPlan"("studentId", "academicYearId");

-- CreateIndex
CREATE INDEX "FeeInstallment_planId_idx" ON "FeeInstallment"("planId");

-- CreateIndex
CREATE INDEX "FeeInstallment_dueDate_reminderSentAt_idx" ON "FeeInstallment"("dueDate", "reminderSentAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeeInstallment_planId_seq_key" ON "FeeInstallment"("planId", "seq");

-- AddForeignKey
ALTER TABLE "FeeInstallmentPlan" ADD CONSTRAINT "FeeInstallmentPlan_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeInstallmentPlan" ADD CONSTRAINT "FeeInstallmentPlan_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeInstallmentPlan" ADD CONSTRAINT "FeeInstallmentPlan_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeInstallmentPlan" ADD CONSTRAINT "FeeInstallmentPlan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeInstallment" ADD CONSTRAINT "FeeInstallment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FeeInstallmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
