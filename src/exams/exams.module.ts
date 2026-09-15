import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { ExamsController } from './exams.controller';
import { ExamResultsController } from './exam-results.controller';
import { ExamSettingsController } from './exam-settings.controller';
import { ExamsService } from './exams.service';
import { ExamAccessService } from './exam-access.service';
import { ExamPapersService } from './exam-papers.service';
import { ExamResultsService } from './exam-results.service';
import { ExamSettingsService } from './exam-settings.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ExamsController, ExamResultsController, ExamSettingsController],
  providers: [
    ExamsService,
    ExamAccessService,
    ExamPapersService,
    ExamResultsService,
    ExamSettingsService,
  ],
  exports: [ExamsService],
})
export class ExamsModule {}
