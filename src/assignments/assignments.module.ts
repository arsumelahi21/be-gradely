import { Module } from '@nestjs/common';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { AssignmentSubmissionsController } from './assignment-submissions.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { S3PresignService } from '../common/services/s3-presign.service';

@Module({
  imports: [PrismaModule],
  controllers: [AssignmentsController, AssignmentSubmissionsController],
  providers: [AssignmentsService, S3PresignService],
  exports: [AssignmentsService],
})
export class AssignmentsModule {}
