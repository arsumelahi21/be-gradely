-- CreateTable
CREATE TABLE "StudentFeeHeadOverride" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "feeHeadId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentFeeHeadOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentFeeHeadOverride_studentId_idx" ON "StudentFeeHeadOverride"("studentId");

-- CreateIndex
CREATE INDEX "StudentFeeHeadOverride_feeHeadId_idx" ON "StudentFeeHeadOverride"("feeHeadId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentFeeHeadOverride_studentId_feeHeadId_key" ON "StudentFeeHeadOverride"("studentId", "feeHeadId");

-- AddForeignKey
ALTER TABLE "StudentFeeHeadOverride" ADD CONSTRAINT "StudentFeeHeadOverride_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFeeHeadOverride" ADD CONSTRAINT "StudentFeeHeadOverride_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "FeeHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
