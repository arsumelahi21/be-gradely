-- AlterEnum
ALTER TYPE "ThreadType" ADD VALUE 'GROUP';

-- AlterTable
ALTER TABLE "MessageThread" ADD COLUMN     "title" TEXT;
