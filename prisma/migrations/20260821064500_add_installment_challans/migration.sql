-- CreateEnum
CREATE TYPE "ChallanGenerationType" AS ENUM ('NORMAL', 'INSTALLMENT');

-- AlterTable
ALTER TABLE "Challan" ADD COLUMN     "generationType" "ChallanGenerationType" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "installmentId" TEXT,
ADD COLUMN     "installmentPlanId" TEXT,
ADD COLUMN     "installmentSeq" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Challan_installmentId_key" ON "Challan"("installmentId");

-- CreateIndex
CREATE INDEX "Challan_installmentPlanId_installmentSeq_idx" ON "Challan"("installmentPlanId", "installmentSeq");

-- AddForeignKey
ALTER TABLE "Challan" ADD CONSTRAINT "Challan_installmentPlanId_fkey" FOREIGN KEY ("installmentPlanId") REFERENCES "FeeInstallmentPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challan" ADD CONSTRAINT "Challan_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "FeeInstallment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
