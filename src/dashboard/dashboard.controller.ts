import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { DashboardService } from './dashboard.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  // School-admin dashboard metrics. SUPER_ADMIN must pass ?schoolId; SCHOOL_ADMIN
  // is pinned to their own school by resolveSchoolId.
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('school-stats')
  schoolStats(@Req() req: any, @Query('schoolId') schoolId?: string) {
    return this.dashboard.getSchoolStats(req.user, { schoolId });
  }

  // One call for the whole school-admin dashboard (count tiles + recent activity
  // + the four stat blocks) — replaces 8 concurrent client requests.
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('school-overview')
  schoolOverview(@Req() req: any, @Query('schoolId') schoolId?: string) {
    return this.dashboard.getSchoolOverview(req.user, { schoolId });
  }

  // One call for the whole super-admin dashboard (schools + cross-school counts).
  @Roles(Role.SUPER_ADMIN)
  @Get('admin-overview')
  adminOverview(@Req() req: any) {
    return this.dashboard.getAdminOverview(req.user);
  }
}
