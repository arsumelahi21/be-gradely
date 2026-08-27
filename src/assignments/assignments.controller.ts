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
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { AssignmentsService } from './assignments.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { RequestUploadDto } from './dto/request-upload.dto';
import { MarkSubmissionDto } from './dto/mark-submission.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Roles(Role.TEACHER)
  @Post()
  @UseInterceptors(
    FilesInterceptor('attachments', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  create(
    @Body() dto: CreateAssignmentDto,
    @UploadedFiles() attachments: any[],
    @Req() req: any,
  ) {
    return this.assignments.create(dto, req.user, attachments);
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
    @Query('includeDownloadUrls') includeDownloadUrls?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.assignments.list(req.user, {
      academicYearId,
      sectionSubjectId,
      studentId,
      includeDownloadUrls: includeDownloadUrls === 'true',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  // Schoolwide assignment completion rate (admin/principal dashboard).
  // Declared before ':id' so "school" isn't captured as an assignment id.
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('school/stats')
  schoolStats(@Req() req: any, @Query('schoolId') schoolId?: string) {
    return this.assignments.getSchoolStats(req.user, { schoolId });
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
    @Query('includeDownloadUrls') includeDownloadUrls?: string,
  ) {
    return this.assignments.get(id, req.user, {
      studentId,
      includeDownloadUrls: includeDownloadUrls === 'true',
    });
  }

  @Roles(Role.TEACHER)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAssignmentDto,
    @Req() req: any,
  ) {
    return this.assignments.update(id, dto, req.user);
  }

  @Roles(Role.TEACHER)
  @Post(':id/publish')
  publish(@Param('id') id: string, @Req() req: any) {
    return this.assignments.publish(id, req.user);
  }

  @Roles(Role.TEACHER)
  @Post(':id/close')
  close(@Param('id') id: string, @Req() req: any) {
    return this.assignments.close(id, req.user);
  }

  @Roles(Role.TEACHER)
  @Post(':id/attachments/request-upload')
  requestAttachmentUpload(
    @Param('id') id: string,
    @Body() dto: RequestUploadDto,
    @Req() req: any,
  ) {
    return this.assignments.requestAttachmentUpload(id, dto, req.user);
  }

  @Roles(Role.TEACHER)
  @Post(':id/attachments/:attachmentId/confirm')
  confirmAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: any,
  ) {
    return this.assignments.confirmAttachment(id, attachmentId, req.user);
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Get(':id/attachments/:attachmentId/request-download')
  requestAttachmentDownload(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: any,
    @Query('studentId') studentId?: string,
  ) {
    return this.assignments.requestAttachmentDownload(
      id,
      attachmentId,
      req.user,
      { studentId },
    );
  }

  @Roles(Role.STUDENT)
  @Post(':id/submissions/request-upload')
  requestUpload(
    @Param('id') id: string,
    @Body() dto: RequestUploadDto,
    @Req() req: any,
  ) {
    return this.assignments.requestUpload(id, dto, req.user);
  }

  @Roles(Role.STUDENT)
  @Post(':id/submissions/:submissionId/submit')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  submit(
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @UploadedFiles() files: any[],
    @Req() req: any,
  ) {
    return this.assignments.submit(id, submissionId, req.user, files);
  }

  @Roles(Role.TEACHER)
  @Get(':id/submissions')
  listSubmissions(@Param('id') id: string, @Req() req: any) {
    return this.assignments.listSubmissions(id, req.user);
  }

  @Roles(Role.TEACHER)
  @Patch('submissions/:submissionId/mark')
  markSubmission(
    @Param('submissionId') submissionId: string,
    @Body() dto: MarkSubmissionDto,
    @Req() req: any,
  ) {
    return this.assignments.markSubmission(submissionId, dto, req.user);
  }

  @Roles(Role.STUDENT, Role.PARENT, Role.TEACHER)
  @Get(':id/results')
  results(
    @Param('id') id: string,
    @Req() req: any,
    @Query('studentId') studentId?: string,
  ) {
    return this.assignments.results(id, req.user, { studentId });
  }
}
