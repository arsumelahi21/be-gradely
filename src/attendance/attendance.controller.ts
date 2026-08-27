import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import {
  SchoolAttendanceStatsQueryDto,
  SectionSubjectAttendanceQueryDto,
  SectionSubjectSummaryQueryDto,
  StudentAttendanceQueryDto,
  StudentAttendanceStatsQueryDto,
  TeacherAttendanceStatsQueryDto,
} from './dto/find-attendance-query.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Post('mark')
  mark(@Body() dto: MarkAttendanceDto, @Req() req: any) {
    return this.attendance.mark(dto, req.user);
  }

  // Schoolwide attendance rate (admin/principal dashboard).
  @Roles(Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get('school/summary')
  schoolSummary(
    @Query() query: SchoolAttendanceStatsQueryDto,
    @Req() req: any,
  ) {
    return this.attendance.getSchoolStats(req.user, query);
  }

  // A teacher's own subject-classes attendance rate (teacher dashboard).
  @Roles(Role.TEACHER)
  @Get('teacher/summary')
  teacherSummary(
    @Query() query: TeacherAttendanceStatsQueryDto,
    @Req() req: any,
  ) {
    return this.attendance.getTeacherStats(req.user, query);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get('section-subject/:sectionSubjectId')
  sectionSubject(
    @Param('sectionSubjectId') sectionSubjectId: string,
    @Query() query: SectionSubjectAttendanceQueryDto,
    @Req() req: any,
  ) {
    return this.attendance.getSectionSubjectAttendance(
      sectionSubjectId,
      query,
      req.user,
    );
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get('section-subject/:sectionSubjectId/summary')
  sectionSubjectSummary(
    @Param('sectionSubjectId') sectionSubjectId: string,
    @Query() query: SectionSubjectSummaryQueryDto,
    @Req() req: any,
  ) {
    return this.attendance.getSectionSubjectSummary(
      sectionSubjectId,
      query,
      req.user,
    );
  }

  @Roles(
    Role.STUDENT,
    Role.PARENT,
    Role.TEACHER,
    Role.SCHOOL_ADMIN,
    Role.SUPER_ADMIN,
  )
  @Get('student/:studentId')
  student(
    @Param('studentId') studentId: string,
    @Query() query: StudentAttendanceQueryDto,
    @Req() req: any,
  ) {
    return this.attendance.getStudentAttendance(studentId, query, req.user);
  }

  @Roles(
    Role.STUDENT,
    Role.PARENT,
    Role.TEACHER,
    Role.SCHOOL_ADMIN,
    Role.SUPER_ADMIN,
  )
  @Get('student/:studentId/stats')
  studentStats(
    @Param('studentId') studentId: string,
    @Query() query: StudentAttendanceStatsQueryDto,
    @Req() req: any,
  ) {
    return this.attendance.getStudentStats(studentId, query, req.user);
  }
}
