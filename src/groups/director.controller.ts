import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { DirectorService } from './director.service';
import { DirectorScopeGuard } from './director-scope.guard';
import { DirectorFeesService } from './director-fees.service';
import { DirectorStudentsService } from './director-students.service';
import { DirectorAttendanceService } from './director-attendance.service';
import { DirectorAcademicsService } from './director-academics.service';
import { InsightsQueryDto } from './dto/insights-query.dto';

// Read-only by design: a director has no write route here, ever.
@UseGuards(JwtAuthGuard, RolesGuard, DirectorScopeGuard)
@Roles(Role.DIRECTOR)
@Controller('director')
export class DirectorController {
  constructor(
    private director: DirectorService,
    private fees: DirectorFeesService,
    private students: DirectorStudentsService,
    private attendanceTab: DirectorAttendanceService,
    private academics: DirectorAcademicsService,
  ) {}

  @Get('branches')
  branches(@Req() req: any) {
    return this.director.branches(req.directorScope);
  }

  // Each insights call fans out over every branch, so it gets a tighter budget than the global 100/min.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('insights/fees')
  feesInsights(@Query() query: InsightsQueryDto, @Req() req: any) {
    return this.fees.insights(req.directorScope, query);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('insights/fees/lists')
  feesLists(@Query() query: InsightsQueryDto, @Req() req: any) {
    return this.fees.lists(req.directorScope, query);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('insights/students')
  studentsInsights(@Query() query: InsightsQueryDto, @Req() req: any) {
    return this.students.insights(req.directorScope, query);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('insights/attendance')
  attendanceInsights(@Query() query: InsightsQueryDto, @Req() req: any) {
    return this.attendanceTab.insights(req.directorScope, query);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('insights/attendance/lists')
  attendanceLists(@Query() query: InsightsQueryDto, @Req() req: any) {
    return this.attendanceTab.lists(req.directorScope, query);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('insights/academics')
  academicsInsights(@Query() query: InsightsQueryDto, @Req() req: any) {
    return this.academics.insights(req.directorScope, query);
  }
}
