import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SchoolsModule } from '../schools/schools.module';
import { FeesModule } from '../fees/fees.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { DirectorController } from './director.controller';
import { DirectorService } from './director.service';
import { DirectorScopeGuard } from './director-scope.guard';
import { DirectorQueriesService } from './director.queries';
import { DirectorFeesService } from './director-fees.service';
import { DirectorStudentsService } from './director-students.service';
import { DirectorAttendanceService } from './director-attendance.service';

@Module({
  imports: [AuditModule, SchoolsModule, FeesModule, AttendanceModule],
  controllers: [GroupsController, DirectorController],
  providers: [
    GroupsService,
    DirectorService,
    DirectorScopeGuard,
    DirectorQueriesService,
    DirectorFeesService,
    DirectorStudentsService,
    DirectorAttendanceService,
  ],
  exports: [DirectorService],
})
export class GroupsModule {}
