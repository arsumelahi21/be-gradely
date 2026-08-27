import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SocialLinksController } from './social-links/social-links.controller';
import { SocialLinksService } from './social-links/social-links.service';
import { AuditModule } from '../audit/audit.module';
import { S3PresignService } from '../common/services/s3-presign.service';

@Module({
  imports: [AuditModule],
  controllers: [UsersController, SocialLinksController],
  providers: [UsersService, SocialLinksService, S3PresignService],
  exports: [UsersService, SocialLinksService],
})
export class UsersModule {}
