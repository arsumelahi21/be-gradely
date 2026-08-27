-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "GuardianRelationship" AS ENUM ('MOTHER', 'FATHER', 'GUARDIAN', 'OTHER');

-- AlterTable
ALTER TABLE "ParentStudent" ADD COLUMN     "relationship" "GuardianRelationship";

-- AlterTable
ALTER TABLE "StudentProfile" ADD COLUMN     "bloodGroup" TEXT,
ADD COLUMN     "gender" "Gender";
