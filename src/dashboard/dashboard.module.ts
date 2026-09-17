import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExamsModule } from '../exams/exams.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [PrismaModule, ExamsModule, AssignmentsModule, AttendanceModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  // The chatbot answers roll-up questions through this service, so the scoping
  // lives in one place rather than being restated against Prisma.
  exports: [DashboardService],
})
export class DashboardModule {}
