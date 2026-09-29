/*
  Warnings:

  - You are about to drop the column `resetTokenExpiresAt` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `resetTokenHash` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "resetTokenExpiresAt",
DROP COLUMN "resetTokenHash",
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
