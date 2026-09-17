import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { ExamResultsService } from './exam-results.service';
import {
  ResultCardQueryDto,
  SaveMarksDto,
  SaveRemarksDto,
} from './dto/results.dto';
import { ReviewReasonDto, StudentQueryDto } from './dto/examination.dto';

const uuid = new ParseUUIDPipe({ version: '4' });

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('exams')
export class ExamResultsController {
  constructor(private readonly results: ExamResultsService) {}

  // Declared before the ':id/...' routes so the literal segment wins the match.
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('sections/:sectionId/result-cards')
  sectionResultCards(
    @Param('sectionId', uuid) sectionId: string,
    @Query() query: ResultCardQueryDto,
    @Req() req: any,
  ) {
    return this.results.sectionResultCards(req.user, sectionId, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('students/:studentId/result-card')
  studentResultCard(
    @Param('studentId', uuid) studentId: string,
    @Query() query: ResultCardQueryDto,
    @Req() req: any,
  ) {
    return this.results.studentResultCard(req.user, studentId, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get(':id/subjects/:subjectId/result')
  subjectResult(
    @Param('id', uuid) id: string,
    @Param('subjectId', uuid) subjectId: string,
    @Req() req: any,
  ) {
    return this.results.subjectResult(id, subjectId, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get(':id/subjects/:subjectId/marks')
  marks(
    @Param('id', uuid) id: string,
    @Param('subjectId', uuid) subjectId: string,
    @Req() req: any,
  ) {
    return this.results.marksRoster(id, subjectId, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Put(':id/subjects/:subjectId/marks')
  saveMarks(
    @Param('id', uuid) id: string,
    @Param('subjectId', uuid) subjectId: string,
    @Body() dto: SaveMarksDto,
    @Req() req: any,
  ) {
    return this.results.saveMarks(id, subjectId, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get(':id/results')
  sheet(@Param('id', uuid) id: string, @Req() req: any) {
    return this.results.results(id, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Put(':id/results/remarks')
  saveRemarks(
    @Param('id', uuid) id: string,
    @Body() dto: SaveRemarksDto,
    @Req() req: any,
  ) {
    return this.results.saveRemarks(id, dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Post(':id/results/finalize')
  finalize(@Param('id', uuid) id: string, @Req() req: any) {
    return this.results.finalize(id, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Post(':id/results/reopen')
  reopen(
    @Param('id', uuid) id: string,
    @Body() dto: ReviewReasonDto,
    @Req() req: any,
  ) {
    return this.results.reopen(id, dto.reason, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get(':id/summary')
  summary(@Param('id', uuid) id: string, @Req() req: any) {
    return this.results.summary(id, req.user);
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Get(':id/report-cards')
  reportCards(
    @Param('id', uuid) id: string,
    @Query() query: StudentQueryDto,
    @Req() req: any,
  ) {
    return this.results.reportCards(id, req.user, query.studentId);
  }
}
