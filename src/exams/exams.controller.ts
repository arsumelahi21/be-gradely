import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { ExamsService } from './exams.service';
import { CreateExamDto } from './dto/create-exam.dto';
import { UpdateExamDto } from './dto/update-exam.dto';
import { MarkExamResultDto } from './dto/mark-exam-result.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('exams')
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Roles(Role.TEACHER)
  @Post()
  create(@Body() dto: CreateExamDto, @Req() req: any) {
    return this.exams.create(dto, req.user);
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Get()
  list(
    @Req() req: any,
    @Query('academicYearId') academicYearId?: string,
    @Query('sectionSubjectId') sectionSubjectId?: string,
    @Query('studentId') studentId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.exams.list(req.user, {
      academicYearId,
      sectionSubjectId,
      studentId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  // Schoolwide average exam score (admin/principal dashboard). Declared before
  // ':id' so "school" isn't captured as an exam id.
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('school/stats')
  schoolStats(@Req() req: any, @Query('schoolId') schoolId?: string) {
    return this.exams.getSchoolStats(req.user, { schoolId });
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() req: any,
    @Query('studentId') studentId?: string,
  ) {
    return this.exams.get(id, req.user, { studentId });
  }

  @Roles(Role.TEACHER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateExamDto, @Req() req: any) {
    return this.exams.update(id, dto, req.user);
  }

  @Roles(Role.TEACHER)
  @Post(':id/publish')
  publish(@Param('id') id: string, @Req() req: any) {
    return this.exams.publish(id, req.user);
  }

  @Roles(Role.TEACHER)
  @Post(':id/close')
  close(@Param('id') id: string, @Req() req: any) {
    return this.exams.close(id, req.user);
  }

  @Roles(Role.TEACHER)
  @Patch(':id/results')
  markResult(
    @Param('id') id: string,
    @Body() dto: MarkExamResultDto,
    @Req() req: any,
  ) {
    return this.exams.markResult(id, dto, req.user);
  }

  @Roles(Role.TEACHER, Role.STUDENT, Role.PARENT)
  @Get(':id/results')
  getResults(
    @Param('id') id: string,
    @Req() req: any,
    @Query('studentId') studentId?: string,
  ) {
    // For teachers: if no studentId, list all results; if studentId provided, get specific
    if (req.user.role === Role.TEACHER && !studentId) {
      return this.exams.listResults(id, req.user);
    }
    // For teachers with studentId, students, and parents: get specific result
    return this.exams.results(id, req.user, { studentId });
  }

  @Roles(Role.TEACHER)
  @Get(':id/students')
  listStudents(@Param('id') id: string, @Req() req: any) {
    return this.exams.listStudents(id, req.user);
  }
}
