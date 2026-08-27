import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { QuizzesService } from './quizzes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { CreateQuizDto } from './dto/create-quiz.dto';
import { AddQuestionDto } from './dto/add-question.dto';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { FindQuizzesQueryDto } from './dto/find-quizzes-query.dto';
import { UpdateQuizDto } from './dto/update-quiz.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { ReorderQuestionsDto } from './dto/reorder-questions.dto';
import { ImportQuizDto } from './dto/import-quiz.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('quizzes')
export class QuizzesController {
  constructor(private readonly quizzes: QuizzesService) {}

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Post()
  create(@Body() dto: CreateQuizDto, @Req() req: any) {
    return this.quizzes.createQuiz(dto, req.user);
  }

  // ---- import (literal routes, registered before ':id') -------------------

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get('import/template')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header(
    'Content-Disposition',
    'attachment; filename="quiz-import-template.csv"',
  )
  importTemplate() {
    return this.quizzes.importTemplate();
  }

  /**
   * Validate-only. Returns the questions it WOULD create plus per-row errors,
   * and writes nothing — the two-step split is what makes a partial quiz
   * impossible.
   */
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Post('import/preview')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 1024 * 1024 }, // 1 MB
    }),
  )
  importPreview(
    @Body() dto: ImportQuizDto,
    @UploadedFile() file: { buffer: Buffer; mimetype?: string } | undefined,
    @Req() req: any,
  ) {
    return this.quizzes.importPreview(dto, file, req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 1024 * 1024 },
    }),
  )
  importCommit(
    @Body() dto: ImportQuizDto,
    @UploadedFile() file: { buffer: Buffer; mimetype?: string } | undefined,
    @Req() req: any,
  ) {
    return this.quizzes.importCommit(dto, file, req.user);
  }

  // Literal routes BEFORE ':id' so they aren't captured as an id.
  @Roles(Role.STUDENT)
  @Get('available')
  available(@Req() req: any) {
    return this.quizzes.available(req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get()
  list(@Query() query: FindQuizzesQueryDto, @Req() req: any) {
    return this.quizzes.listQuizzes(req.user, query);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Post(':id/questions')
  addQuestion(
    @Param('id') id: string,
    @Body() dto: AddQuestionDto,
    @Req() req: any,
  ) {
    return this.quizzes.addQuestion(id, dto, req.user);
  }

  // 'order' is a literal and MUST be registered before ':questionId', or it
  // would be captured as one.
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Patch(':id/questions/order')
  reorderQuestions(
    @Param('id') id: string,
    @Body() dto: ReorderQuestionsDto,
    @Req() req: any,
  ) {
    return this.quizzes.reorderQuestions(id, dto, req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Patch(':id/questions/:questionId')
  updateQuestion(
    @Param('id') id: string,
    @Param('questionId') questionId: string,
    @Body() dto: UpdateQuestionDto,
    @Req() req: any,
  ) {
    return this.quizzes.updateQuestion(id, questionId, dto, req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Delete(':id/questions/:questionId')
  deleteQuestion(
    @Param('id') id: string,
    @Param('questionId') questionId: string,
    @Req() req: any,
  ) {
    return this.quizzes.deleteQuestion(id, questionId, req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Patch(':id/publish')
  publish(@Param('id') id: string, @Req() req: any) {
    return this.quizzes.publish(id, req.user);
  }

  @Roles(Role.STUDENT)
  @Post(':id/attempts')
  startAttempt(@Param('id') id: string, @Req() req: any) {
    return this.quizzes.startAttempt(id, req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get(':id/results')
  results(
    @Param('id') id: string,
    @Query() query: FindQuizzesQueryDto,
    @Req() req: any,
  ) {
    return this.quizzes.getResults(id, req.user, query);
  }

  // Attempt-scoped routes ('attempts' is a literal segment, distinct from :id).
  @Roles(Role.STUDENT)
  @Patch('attempts/:attemptId/submit')
  submit(
    @Param('attemptId') attemptId: string,
    @Body() dto: SubmitAttemptDto,
    @Req() req: any,
  ) {
    return this.quizzes.submitAttempt(attemptId, dto, req.user);
  }

  @Roles(
    Role.STUDENT,
    Role.PARENT,
    Role.TEACHER,
    Role.SCHOOL_ADMIN,
    Role.SUPER_ADMIN,
  )
  @Get('attempts/:attemptId')
  attempt(@Param('attemptId') attemptId: string, @Req() req: any) {
    return this.quizzes.getAttempt(attemptId, req.user);
  }

  // Bare ':id' routes LAST so they don't shadow the literal routes above.
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateQuizDto, @Req() req: any) {
    return this.quizzes.updateQuiz(id, dto, req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get(':id')
  getOne(@Param('id') id: string, @Req() req: any) {
    return this.quizzes.getQuizForAuthor(id, req.user);
  }
}
