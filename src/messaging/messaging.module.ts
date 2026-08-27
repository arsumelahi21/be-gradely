import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { PrismaModule } from '../prisma/prisma.module';
import { S3PresignService } from '../common/services/s3-presign.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [MessagingController],
  providers: [MessagingService, S3PresignService],
})
export class MessagingModule {}
