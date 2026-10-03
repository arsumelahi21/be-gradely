import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { PrismaModule } from '../prisma/prisma.module';
import { S3PresignService } from '../common/services/s3-presign.service';
import { AuditModule } from '../audit/audit.module';
import { GroupsModule } from '../groups/groups.module';

@Module({
  imports: [PrismaModule, AuditModule, GroupsModule],
  controllers: [MessagingController],
  providers: [MessagingService, S3PresignService],
})
export class MessagingModule {}
