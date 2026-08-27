import { Module } from '@nestjs/common';
import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementsScheduler } from './announcements.scheduler';
import { PrismaModule } from '../prisma/prisma.module';
import { S3PresignService } from '../common/services/s3-presign.service';

@Module({
  imports: [PrismaModule],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService, AnnouncementsScheduler, S3PresignService],
})
export class AnnouncementsModule {}
