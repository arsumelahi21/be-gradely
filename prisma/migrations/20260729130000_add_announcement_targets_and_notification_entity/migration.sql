-- CreateEnum
CREATE TYPE "AnnouncementTargetKind" AS ENUM ('SCHOOL', 'ALL_TEACHERS', 'ALL_STUDENTS', 'ALL_PARENTS', 'CLASS', 'SECTION');

-- AlterTable
ALTER TABLE "Announcement" ALTER COLUMN "audienceScope" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "entityType" TEXT;

-- CreateTable
CREATE TABLE "AnnouncementTarget" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "kind" "AnnouncementTargetKind" NOT NULL,
    "refId" TEXT,

    CONSTRAINT "AnnouncementTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnnouncementTarget_announcementId_idx" ON "AnnouncementTarget"("announcementId");

-- CreateIndex
CREATE INDEX "AnnouncementTarget_kind_refId_idx" ON "AnnouncementTarget"("kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementTarget_announcementId_kind_refId_key" ON "AnnouncementTarget"("announcementId", "kind", "refId");

-- CreateIndex
CREATE INDEX "Notification_entityType_entityId_idx" ON "Notification"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "AnnouncementTarget" ADD CONSTRAINT "AnnouncementTarget_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: convert legacy audienceScope/sectionId into AnnouncementTarget rows
-- (SCHOOL -> a SCHOOL target; SECTION -> a SECTION target carrying the sectionId).
INSERT INTO "AnnouncementTarget" ("id", "announcementId", "kind", "refId")
SELECT gen_random_uuid(), "id",
       CASE WHEN "audienceScope" = 'SECTION' THEN 'SECTION'::"AnnouncementTargetKind"
            ELSE 'SCHOOL'::"AnnouncementTargetKind" END,
       CASE WHEN "audienceScope" = 'SECTION' THEN "sectionId" ELSE NULL END
FROM "Announcement";
