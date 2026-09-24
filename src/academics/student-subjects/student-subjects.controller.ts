import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { StudentSubjectsService } from './student-subjects.service';
import { FindStudentSubjectsQueryDto } from './dto/find-student-subjects-query.dto';
import { UpdateStudentSubjectsDto } from './dto/update-student-subjects.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('student-subjects')
export class StudentSubjectsController {
  constructor(private readonly studentSubjects: StudentSubjectsService) {}

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get()
  matrix(@Query() query: FindStudentSubjectsQueryDto, @Req() req: any) {
    return this.studentSubjects.matrix(query, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.STUDENT, Role.PARENT)
  @Get('student/:studentId')
  forStudent(@Param('studentId') studentId: string, @Req() req: any) {
    return this.studentSubjects.forStudent(studentId, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch()
  update(@Body() dto: UpdateStudentSubjectsDto, @Req() req: any) {
    return this.studentSubjects.update(dto, req.user);
  }
}
