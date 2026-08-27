import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { AssignmentsService } from './assignments.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assignment-submissions')
export class AssignmentSubmissionsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Roles(Role.STUDENT, Role.PARENT, Role.TEACHER)
  @Get(':submissionId/request-download')
  requestDownload(
    @Param('submissionId') submissionId: string,
    @Req() req: any,
  ) {
    return this.assignments.requestDownload(submissionId, req.user);
  }
}
