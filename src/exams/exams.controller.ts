import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { MAX_EXAM_PAPER_BYTES } from '../common/upload/attachment-rules';
import { ExamsService } from './exams.service';
import { ExamPapersService, UploadedPaperFile } from './exam-papers.service';
import { ExamResultsService } from './exam-results.service';
import {
  CreateExaminationDto,
  ListExaminationsQueryDto,
  ReviewReasonDto,
  StudentQueryDto,
  UpdateExaminationDto,
} from './dto/examination.dto';
import {
  CreateExamSubjectDto,
  UpdateExamSubjectDto,
} from './dto/exam-subject.dto';

const uuid = new ParseUUIDPipe({ version: '4' });

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('exams')
export class ExamsController {
  constructor(
    private readonly exams: ExamsService,
    private readonly papers: ExamPapersService,
    private readonly results: ExamResultsService,
  ) {}

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Post()
  create(@Body() dto: CreateExaminationDto, @Req() req: any) {
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
  list(@Query() query: ListExaminationsQueryDto, @Req() req: any) {
    return this.exams.list(req.user, query);
  }

  // Declared before ':id' so these literals aren't captured as an id.
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('school/stats')
  schoolStats(@Req() req: any, @Query('schoolId') schoolId?: string) {
    return this.exams.getSchoolStats(req.user, { schoolId });
  }

  @Roles(Role.STUDENT, Role.PARENT)
  @Get('results/me/summary')
  myResultsSummary(@Query() query: StudentQueryDto, @Req() req: any) {
    return this.results.myResultsSummary(req.user, query.studentId);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Get('results/student/:studentId/summary')
  studentResultsSummary(
    @Param('studentId', uuid) studentId: string,
    @Req() req: any,
  ) {
    return this.results.resultsSummaryForStudent(req.user, studentId);
  }

  @Roles(Role.STUDENT, Role.PARENT)
  @Get('results/me')
  myResults(@Query() query: StudentQueryDto, @Req() req: any) {
    return this.results.myResults(req.user, query.studentId);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Get('results/student/:studentId')
  studentResults(@Param('studentId', uuid) studentId: string, @Req() req: any) {
    return this.results.resultsForStudent(req.user, studentId);
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
    @Param('id', uuid) id: string,
    @Query() query: StudentQueryDto,
    @Req() req: any,
  ) {
    return this.exams.get(id, req.user, query.studentId);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Patch(':id')
  update(
    @Param('id', uuid) id: string,
    @Body() dto: UpdateExaminationDto,
    @Req() req: any,
  ) {
    return this.exams.update(id, dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Delete(':id')
  remove(@Param('id', uuid) id: string, @Req() req: any) {
    return this.exams.remove(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get(':id/history')
  history(@Param('id', uuid) id: string, @Req() req: any) {
    return this.exams.history(id, req.user);
  }

  // ---- Subject papers ----

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Post(':id/subjects')
  addSubject(
    @Param('id', uuid) id: string,
    @Body() dto: CreateExamSubjectDto,
    @Req() req: any,
  ) {
    return this.exams.addSubject(id, dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Patch(':id/subjects/:subjectId')
  updateSubject(
    @Param('id', uuid) id: string,
    @Param('subjectId', uuid) subjectId: string,
    @Body() dto: UpdateExamSubjectDto,
    @Req() req: any,
  ) {
    return this.exams.updateSubject(id, subjectId, dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Delete(':id/subjects/:subjectId')
  removeSubject(
    @Param('id', uuid) id: string,
    @Param('subjectId', uuid) subjectId: string,
    @Req() req: any,
  ) {
    return this.exams.removeSubject(id, subjectId, req.user);
  }

  // ---- Confidential exam paper: staff only, re-authorized on every request ----

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Put(':id/subjects/:subjectId/paper')
  @UseInterceptors(
    FileInterceptor('paper', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_EXAM_PAPER_BYTES, files: 1 },
    }),
  )
  uploadPaper(
    @Param('id', uuid) id: string,
    @Param('subjectId', uuid) subjectId: string,
    @UploadedFile() file: UploadedPaperFile | undefined,
    @Req() req: any,
  ) {
    return this.papers.upload(id, subjectId, file, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Delete(':id/subjects/:subjectId/paper')
  removePaper(
    @Param('id', uuid) id: string,
    @Param('subjectId', uuid) subjectId: string,
    @Req() req: any,
  ) {
    return this.papers.remove(id, subjectId, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get(':id/subjects/:subjectId/paper')
  async readPaper(
    @Param('id', uuid) id: string,
    @Param('subjectId', uuid) subjectId: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const { data, fileName } = await this.papers.read(id, subjectId, req.user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.send(data);
  }

  // ---- Review workflow ----

  @Roles(Role.TEACHER)
  @Post(':id/submit')
  submit(@Param('id', uuid) id: string, @Req() req: any) {
    return this.exams.submit(id, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Post(':id/request-changes')
  requestChanges(
    @Param('id', uuid) id: string,
    @Body() dto: ReviewReasonDto,
    @Req() req: any,
  ) {
    return this.exams.requestChanges(id, dto.reason, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Post(':id/reject')
  reject(
    @Param('id', uuid) id: string,
    @Body() dto: ReviewReasonDto,
    @Req() req: any,
  ) {
    return this.exams.reject(id, dto.reason, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Post(':id/publish')
  publish(@Param('id', uuid) id: string, @Req() req: any) {
    return this.exams.publish(id, req.user);
  }
}
