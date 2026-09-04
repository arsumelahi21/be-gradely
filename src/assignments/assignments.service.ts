import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { compressImage } from '../common/upload/image-compress';
import { assertPdfOnly } from '../common/upload/attachment-rules';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { RequestUploadDto } from './dto/request-upload.dto';
import { MarkSubmissionDto } from './dto/mark-submission.dto';
import { S3PresignService } from '../common/services/s3-presign.service';
import { CacheService } from '../common/services/cache.service';
import { invalidateSchoolStats } from '../common/cache/stats-cache';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NOTIFICATION_CREATE,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import {
  parentUserIds,
  sectionStudentIds,
  studentUserIds,
} from '../common/notifications/recipients';
import { AssignmentAttachmentStatus, Prisma } from '@prisma/client';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3PresignService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
  ) {}

  async create(
    dto: CreateAssignmentDto,
    actor: Actor,
    attachments?: Array<{
      originalname?: string;
      mimetype?: string;
      size?: number;
      buffer?: Buffer;
    }>,
  ) {
    this.ensureRole(actor, [Role.TEACHER]);
    const schoolId = this.requireSchoolId(actor);

    const teacher = await this.prisma.teacherProfile.findFirst({
      where: { userId: actor.userId, schoolId },
    });
    if (!teacher) throw new ForbiddenException('Teacher profile not found');

    const [academicYear, sectionSubject] = await Promise.all([
      this.prisma.academicYear.findUnique({
        where: { id: dto.academicYearId },
      }),
      (this.prisma as any).sectionSubject.findUnique({
        where: { id: dto.sectionSubjectId },
        include: { section: true },
      }),
    ]);

    if (!academicYear) throw new BadRequestException('Invalid academicYearId');
    if (academicYear.schoolId !== schoolId)
      throw new ForbiddenException('Cross-school access denied');

    if (!sectionSubject)
      throw new BadRequestException('Invalid sectionSubjectId');
    if (sectionSubject.section.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }

    const teachesThis = await this.isTeacherAssignedToSectionSubject({
      teacherId: teacher.id,
      sectionId: sectionSubject.sectionId,
      sectionSubjectTeacherId: sectionSubject.teacherId,
    });

    if (!teachesThis) {
      throw new ForbiddenException(
        'Teacher is not assigned to this subject/section',
      );
    }

    const created = await (this.prisma as any).assignment.create({
      data: {
        schoolId,
        academicYearId: dto.academicYearId,
        sectionSubjectId: dto.sectionSubjectId,
        createdByTeacherId: teacher.id,
        title: dto.title,
        description: dto.description ?? null,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        maxScore: dto.maxScore ?? null,
      },
      include: this.assignmentInclude(),
    });

    const files = Array.isArray(attachments)
      ? attachments.filter((f) => f && f.buffer)
      : [];
    if (!files.length) return created;

    // Assignments accept PDF only — reject the whole batch before storing any.
    for (const file of files) {
      assertPdfOnly({
        mimeType: file.mimetype,
        fileName: file.originalname,
        buffer: file.buffer as Buffer,
      });
    }

    for (const file of files) {
      const safeName = (file.originalname ?? 'attachment').replace(
        /[^a-zA-Z0-9._-]/g,
        '_',
      );
      // Server-proxied upload: compress images to KBs before storing.
      const { buffer, mimeType } = await compressImage(
        file.buffer as Buffer,
        file.mimetype,
      );
      const key = await this.s3.keyFor(
        created.schoolId,
        'assignments',
        actor.userId,
        safeName,
      );

      await this.s3.putObject({
        key,
        body: buffer,
        contentType: mimeType,
        contentDisposition: file.originalname
          ? `attachment; filename="${safeName}"`
          : undefined,
      });

      await (this.prisma as any).assignmentAttachment.create({
        data: {
          assignmentId: created.id,
          uploadedByTeacherId: teacher.id,
          s3Key: key,
          fileName: file.originalname ?? null,
          mimeType: mimeType ?? null,
          sizeBytes: buffer.length,
          status: 'READY',
        },
      });
    }

    const assignment = await (this.prisma as any).assignment.findUnique({
      where: { id: created.id },
      include: this.assignmentInclude(),
    });

    // Enrich attachments with download URLs
    if (assignment.attachments && assignment.attachments.length > 0) {
      const enriched = await this.enrichAttachmentsWithDownloadUrls([
        assignment,
      ]);
      return enriched[0];
    }

    return assignment;
  }

  async list(
    actor: Actor,
    query: {
      academicYearId?: string;
      sectionSubjectId?: string;
      studentId?: string;
      includeDownloadUrls?: boolean;
      page?: number;
      pageSize?: number;
    },
  ) {
    const role = actor.role;
    let where: any;
    // For STUDENT/PARENT, the one student whose submission we fold into the list.
    let targetStudentId: string | undefined;

    if ([Role.SUPER_ADMIN, Role.SCHOOL_ADMIN].includes(role)) {
      // Admin list: allow filtering by academicYearId/sectionSubjectId, default all within their school
      const schoolId =
        role === Role.SUPER_ADMIN
          ? (actor.schoolId ?? undefined)
          : actor.schoolId!;
      where = {};
      if (role === Role.SCHOOL_ADMIN) where.schoolId = actor.schoolId!;
      if (query.academicYearId) where.academicYearId = query.academicYearId;
      if (query.sectionSubjectId)
        where.sectionSubjectId = query.sectionSubjectId;
      if (schoolId) where.schoolId = schoolId;
    } else if (role === Role.TEACHER) {
      if (!actor.schoolId) throw new ForbiddenException('No school context');
      const teacher = await this.prisma.teacherProfile.findFirst({
        where: { userId: actor.userId, schoolId: actor.schoolId },
      });
      if (!teacher) {
        throw new ForbiddenException(
          'Teacher profile not found. Please ensure your teacher profile is set up.',
        );
      }
      where = { schoolId: actor.schoolId, createdByTeacherId: teacher.id };
      if (query.academicYearId) where.academicYearId = query.academicYearId;
      if (query.sectionSubjectId)
        where.sectionSubjectId = query.sectionSubjectId;
    } else if (role === Role.STUDENT) {
      const student = await this.getStudentOrThrow(actor);
      targetStudentId = student.id;
      const sectionSubjectIds = await this.sectionSubjectIdsForStudent(
        student.id,
        query.academicYearId,
      );
      where = {
        sectionSubjectId: { in: sectionSubjectIds },
        status: { in: ['PUBLISHED', 'CLOSED'] },
      };
      if (query.academicYearId) where.academicYearId = query.academicYearId;
      if (query.sectionSubjectId)
        where.sectionSubjectId = query.sectionSubjectId;
    } else if (role === Role.PARENT) {
      const parent = await this.getParentOrThrow(actor);
      if (!query.studentId)
        throw new BadRequestException('studentId is required');
      await this.ensureChildOfParent(parent.id, query.studentId);
      targetStudentId = query.studentId;
      const sectionSubjectIds = await this.sectionSubjectIdsForStudent(
        query.studentId,
        query.academicYearId,
      );
      where = {
        sectionSubjectId: { in: sectionSubjectIds },
        status: { in: ['PUBLISHED', 'CLOSED'] },
      };
      if (query.academicYearId) where.academicYearId = query.academicYearId;
      if (query.sectionSubjectId)
        where.sectionSubjectId = query.sectionSubjectId;
    } else {
      throw new ForbiddenException('Not allowed');
    }

    const include = this.assignmentInclude(targetStudentId);
    const orderBy = { createdAt: 'desc' as const };
    // Presigning every attachment costs ~50-100ms/file and list cards never
    // show them — only presign when a caller opts in via includeDownloadUrls.
    const enrich = (rows: any[]) =>
      query.includeDownloadUrls
        ? this.enrichAttachmentsWithDownloadUrls(rows)
        : Promise.resolve(rows);

    // Backward-compatible: plain array unless `page` is supplied
    // (dropdown/count callers keep working); envelope when paginating.
    if (query.page == null) {
      const rows = await this.prisma.assignment.findMany({
        where,
        orderBy,
        include,
      });
      return await enrich(rows);
    }

    const { page, pageSize, skip, take } = resolvePagination(query);
    const [rows, total] = await Promise.all([
      this.prisma.assignment.findMany({ where, orderBy, include, skip, take }),
      this.prisma.assignment.count({ where }),
    ]);
    const items = await enrich(rows);
    return { items, total, page, pageSize };
  }

  /**
   * Schoolwide PUBLISHED-assignment completion rate: submissions in
   * SUBMITTED|MARKED ÷ expected (ACTIVE-enrolled students). Divide-by-zero guarded.
   */
  async getSchoolStats(actor: Actor, opts?: { schoolId?: string }) {
    this.ensureRole(actor, [Role.SUPER_ADMIN, Role.SCHOOL_ADMIN]);
    const schoolId =
      actor.role === Role.SUPER_ADMIN ? opts?.schoolId : actor.schoolId;
    if (!schoolId) throw new BadRequestException('schoolId is required');
    // ponytail: 60s TTL, no write-invalidation — stats tolerate <60s staleness.
    return this.cache.wrap(`assignments:school-stats:${schoolId}`, 60, () =>
      this.computeSchoolStats(schoolId),
    );
  }

  private async computeSchoolStats(schoolId: string) {
    const assignments = await (this.prisma as any).assignment.findMany({
      where: { schoolId, status: 'PUBLISHED' },
      select: { id: true, sectionSubject: { select: { sectionId: true } } },
    });
    if (assignments.length === 0) {
      return {
        schoolId,
        assignmentCount: 0,
        expected: 0,
        submitted: 0,
        graded: 0,
        completionRate: 0,
      };
    }

    const assignmentIds = assignments.map((a: any) => a.id);
    const sectionIds = [
      ...new Set(assignments.map((a: any) => a.sectionSubject.sectionId)),
    ] as string[];

    // Enrolled count per section — aggregate in SQL (was: stream every active
    // enrollment to Node to count in a Map).
    const enrolledGroups = await this.prisma.enrollment.groupBy({
      by: ['sectionId'],
      where: { sectionId: { in: sectionIds }, status: 'ACTIVE' },
      _count: { _all: true },
    });
    const enrolledBySection = new Map<string, number>(
      enrolledGroups.map((g) => [g.sectionId, g._count._all]),
    );
    const expected = assignments.reduce(
      (sum: number, a: any) =>
        sum + (enrolledBySection.get(a.sectionSubject.sectionId) ?? 0),
      0,
    );

    // Count submissions by status in SQL (was: stream every submission to Node).
    const submissionGroups = await (
      this.prisma as any
    ).assignmentSubmission.groupBy({
      by: ['status'],
      where: {
        assignmentId: { in: assignmentIds },
        status: { in: ['SUBMITTED', 'MARKED'] },
      },
      _count: { _all: true },
    });
    let submitted = 0;
    let graded = 0;
    for (const g of submissionGroups as {
      status: string;
      _count: { _all: number };
    }[]) {
      submitted += g._count._all;
      if (g.status === 'MARKED') graded += g._count._all;
    }

    return {
      schoolId,
      assignmentCount: assignments.length,
      expected,
      submitted,
      graded,
      completionRate:
        expected === 0 ? 0 : Math.round((submitted / expected) * 10000) / 10000,
    };
  }

  async get(
    id: string,
    actor: Actor,
    opts?: { studentId?: string; includeDownloadUrls?: boolean },
  ) {
    const assignment = await (this.prisma as any).assignment.findUnique({
      where: { id },
      include: this.assignmentInclude(),
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    await this.enforceAssignmentAccess(assignment, actor, opts);

    if (opts?.includeDownloadUrls && assignment.attachments) {
      return this.enrichAttachmentsWithDownloadUrls([assignment])[0];
    }

    return assignment;
  }

  async update(id: string, dto: UpdateAssignmentDto, actor: Actor) {
    this.ensureRole(actor, [Role.TEACHER]);

    const assignment = await (this.prisma as any).assignment.findUnique({
      where: { id },
      include: { sectionSubject: { include: { section: true } } },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    const teacher = await this.getTeacherOrThrow(actor, assignment.schoolId);

    if (assignment.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException('Only creator teacher can update');
    }

    if (dto.status && !['DRAFT', 'PUBLISHED', 'CLOSED'].includes(dto.status)) {
      throw new BadRequestException('Invalid status');
    }

    // Validate and update academicYearId if provided
    let academicYearId = assignment.academicYearId;
    if (
      dto.academicYearId &&
      dto.academicYearId !== assignment.academicYearId
    ) {
      const academicYear = await this.prisma.academicYear.findUnique({
        where: { id: dto.academicYearId },
      });
      if (!academicYear)
        throw new BadRequestException('Invalid academicYearId');
      if (academicYear.schoolId !== assignment.schoolId) {
        throw new ForbiddenException(
          'Academic year must belong to the same school',
        );
      }
      academicYearId = dto.academicYearId;
    }

    // Validate and update sectionSubjectId if provided
    let sectionSubjectId = assignment.sectionSubjectId;
    if (
      dto.sectionSubjectId &&
      dto.sectionSubjectId !== assignment.sectionSubjectId
    ) {
      const sectionSubject = await (
        this.prisma as any
      ).sectionSubject.findUnique({
        where: { id: dto.sectionSubjectId },
        include: { section: true },
      });
      if (!sectionSubject)
        throw new BadRequestException('Invalid sectionSubjectId');
      if (sectionSubject.section.schoolId !== assignment.schoolId) {
        throw new ForbiddenException(
          'Section subject must belong to the same school',
        );
      }

      // Verify teacher is assigned to the new section-subject
      const teachesThis = await this.isTeacherAssignedToSectionSubject({
        teacherId: teacher.id,
        sectionId: sectionSubject.sectionId,
        sectionSubjectTeacherId: sectionSubject.teacherId,
      });
      if (!teachesThis) {
        throw new ForbiddenException(
          'Teacher is not assigned to this subject/section',
        );
      }

      sectionSubjectId = dto.sectionSubjectId;
    }

    const updated = await (this.prisma as any).assignment.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && {
          description: dto.description ?? null,
        }),
        ...(dto.dueAt !== undefined && {
          dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        }),
        ...(dto.maxScore !== undefined && { maxScore: dto.maxScore ?? null }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.academicYearId !== undefined && { academicYearId }),
        ...(dto.sectionSubjectId !== undefined && { sectionSubjectId }),
      },
      include: this.assignmentInclude(),
    });

    // Notify enrolled students when the assignment is newly published.
    if (dto.status === 'PUBLISHED' && assignment.status !== 'PUBLISHED') {
      await this.notifyAssignmentPublished(updated);
    }
    return updated;
  }

  /** Fan-out a "new assignment" notification to the section's students. */
  private async notifyAssignmentPublished(a: {
    id: string;
    title: string;
    sectionSubject?: { sectionId: string } | null;
  }) {
    const sectionId = a.sectionSubject?.sectionId;
    if (!sectionId) return;
    const studentIds = await sectionStudentIds(this.prisma, sectionId);
    const userIds = await studentUserIds(this.prisma, studentIds);
    if (!userIds.length) return;
    this.eventEmitter.emit(NOTIFICATION_CREATE, {
      userIds,
      type: 'ASSIGNMENT_PUBLISHED',
      title: 'New assignment',
      body: `"${a.title}" was posted.`,
      link: `/assignments/${a.id}`,
      notifyPreferenceKey: 'notifyGrades',
    } as NotificationCreateEvent);
  }

  async publish(id: string, actor: Actor) {
    return this.update(id, { status: 'PUBLISHED' } as any, actor);
  }

  async close(id: string, actor: Actor) {
    return this.update(id, { status: 'CLOSED' } as any, actor);
  }

  async requestUpload(
    assignmentId: string,
    dto: RequestUploadDto,
    actor: Actor,
  ) {
    this.ensureRole(actor, [Role.STUDENT]);
    assertPdfOnly({ mimeType: dto.mimeType, fileName: dto.fileName });

    const assignment = await (this.prisma as any).assignment.findUnique({
      where: { id: assignmentId },
      include: {
        sectionSubject: {
          include: {
            section: true,
            subject: true,
          },
        },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (!['PUBLISHED', 'CLOSED'].includes(assignment.status)) {
      throw new ForbiddenException('Assignment is not published');
    }

    const student = await this.getStudentOrThrow(actor);

    const enrolled = await this.prisma.enrollment.findFirst({
      where: {
        studentId: student.id,
        sectionId: assignment.sectionSubject.sectionId,
        academicYearId: assignment.academicYearId,
        status: 'ACTIVE',
      } as any,
    });
    if (!enrolled)
      throw new ForbiddenException('Student not enrolled for this assignment');

    const safeName = (dto.fileName ?? 'submission').replace(
      /[^a-zA-Z0-9._-]/g,
      '_',
    );
    const key = await this.s3.keyFor(
      assignment.schoolId,
      'submissions',
      actor.userId,
      safeName,
    );

    const submission = await (this.prisma as any).assignmentSubmission.upsert({
      where: {
        assignmentId_studentId: {
          assignmentId: assignment.id,
          studentId: student.id,
        },
      },
      create: {
        assignmentId: assignment.id,
        studentId: student.id,
        s3Key: key,
        fileName: dto.fileName ?? null,
        mimeType: dto.mimeType ?? null,
        sizeBytes: dto.sizeBytes ?? null,
        status: 'UPLOADING',
      },
      update: {
        ...(dto.fileName !== undefined && { fileName: dto.fileName ?? null }),
        ...(dto.mimeType !== undefined && { mimeType: dto.mimeType ?? null }),
        ...(dto.sizeBytes !== undefined && {
          sizeBytes: dto.sizeBytes ?? null,
        }),
        s3Key: key,
        ...(dto.mimeType ? { status: 'UPLOADING' } : {}),
      },
    });

    const { url: uploadUrl } = await this.s3.presignPutObject({
      key,
      contentType: dto.mimeType,
    });

    // Log: Student requested upload URL
    console.log('\n📤 [ASSIGNMENT UPLOAD REQUEST]');
    console.log(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    );
    console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
    console.log(`👤 Student ID: ${student.id}`);
    console.log(`👤 Student Name: ${student.fullName || 'N/A'}`);
    console.log(`📝 Assignment ID: ${assignment.id}`);
    console.log(`📝 Assignment Title: ${assignment.title}`);
    console.log(
      `📁 Section: ${assignment.sectionSubject.section?.name || 'N/A'}`,
    );
    console.log(
      `📚 Subject: ${assignment.sectionSubject.subject?.name || 'N/A'}`,
    );
    console.log(`📄 Submission ID: ${submission.id}`);
    console.log(`📎 File Name: ${dto.fileName || 'N/A'}`);
    console.log(
      `📦 File Size: ${dto.sizeBytes ? `${(dto.sizeBytes / 1024).toFixed(2)} KB` : 'N/A'}`,
    );
    console.log(`🔖 MIME Type: ${dto.mimeType || 'N/A'}`);
    console.log(`☁️  S3 Key: ${key}`);
    console.log(`📊 Status: UPLOADING`);
    console.log(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n',
    );

    return { submissionId: submission.id, s3Key: key, uploadUrl };
  }

  async requestAttachmentUpload(
    assignmentId: string,
    dto: RequestUploadDto,
    actor: Actor,
  ) {
    this.ensureRole(actor, [Role.TEACHER]);
    assertPdfOnly({ mimeType: dto.mimeType, fileName: dto.fileName });

    const assignment = await (this.prisma as any).assignment.findUnique({
      where: { id: assignmentId },
      include: { sectionSubject: { include: { section: true } } },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    const teacher = await this.getTeacherOrThrow(actor, assignment.schoolId);
    if (assignment.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException('Only creator teacher can add attachments');
    }

    const safeName = (dto.fileName ?? 'attachment').replace(
      /[^a-zA-Z0-9._-]/g,
      '_',
    );
    const key = await this.s3.keyFor(
      assignment.schoolId,
      'assignments',
      actor.userId,
      safeName,
    );

    const attachment = await (this.prisma as any).assignmentAttachment.create({
      data: {
        assignmentId: assignment.id,
        uploadedByTeacherId: teacher.id,
        s3Key: key,
        fileName: dto.fileName ?? null,
        mimeType: dto.mimeType ?? null,
        sizeBytes: dto.sizeBytes ?? null,
        status: 'UPLOADING',
      },
    });

    const { url: uploadUrl } = await this.s3.presignPutObject({
      key,
      contentType: dto.mimeType,
    });
    return {
      attachmentId: attachment.id,
      s3Key: key,
      upload: { method: 'PUT', url: uploadUrl },
    };
  }

  async confirmAttachment(
    assignmentId: string,
    attachmentId: string,
    actor: Actor,
  ) {
    this.ensureRole(actor, [Role.TEACHER]);

    const attachment = await (
      this.prisma as any
    ).assignmentAttachment.findUnique({
      where: { id: attachmentId },
      include: { assignment: true },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');
    if (attachment.assignmentId !== assignmentId)
      throw new BadRequestException('Mismatched assignment');

    const teacher = await this.getTeacherOrThrow(
      actor,
      attachment.assignment.schoolId,
    );
    if (attachment.assignment.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException(
        'Only creator teacher can confirm attachments',
      );
    }

    return (this.prisma as any).assignmentAttachment.update({
      where: { id: attachment.id },
      data: { status: 'READY' },
    });
  }

  async requestAttachmentDownload(
    assignmentId: string,
    attachmentId: string,
    actor: Actor,
    opts?: { studentId?: string },
  ) {
    const attachment = await (
      this.prisma as any
    ).assignmentAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        assignment: {
          include: { sectionSubject: { include: { section: true } } },
        },
      },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');
    if (attachment.assignmentId !== assignmentId)
      throw new BadRequestException('Mismatched assignment');
    if (attachment.status !== 'READY')
      throw new ForbiddenException('Attachment not ready');

    await this.enforceAssignmentAccess(attachment.assignment, actor, opts);

    const { url } = await this.s3.presignGetObject({ key: attachment.s3Key });
    return { attachmentId: attachment.id, downloadUrl: url };
  }

  async submit(
    assignmentId: string,
    submissionId: string,
    actor: Actor,
    files?: Array<{
      originalname?: string;
      mimetype?: string;
      size?: number;
      buffer?: Buffer;
    }>,
  ) {
    this.ensureRole(actor, [Role.STUDENT]);
    const student = await this.getStudentOrThrow(actor);

    // First, try to find submission by ID
    let submission = await (this.prisma as any).assignmentSubmission.findUnique(
      {
        where: { id: submissionId },
        include: {
          assignment: {
            include: {
              sectionSubject: {
                include: {
                  section: true,
                  subject: true,
                },
              },
              academicYear: true,
              createdByTeacher: true,
            },
          },
          student: true,
        },
      },
    );

    // If submission not found by ID, try finding by assignmentId + studentId
    if (!submission) {
      submission = await (this.prisma as any).assignmentSubmission.findUnique({
        where: {
          assignmentId_studentId: {
            assignmentId: assignmentId,
            studentId: student.id,
          },
        },
        include: {
          assignment: {
            include: {
              sectionSubject: {
                include: {
                  section: true,
                  subject: true,
                },
              },
              academicYear: true,
              createdByTeacher: true,
            },
          },
          student: true,
        },
      });
    }

    // If still not found, check if assignment exists and student is enrolled
    if (!submission) {
      const assignment = await (this.prisma as any).assignment.findUnique({
        where: { id: assignmentId },
        include: {
          sectionSubject: {
            include: {
              section: true,
              subject: true,
            },
          },
          academicYear: true,
        },
      });

      if (!assignment) {
        throw new NotFoundException('Assignment not found');
      }

      // Verify student enrollment
      const enrolled = await this.prisma.enrollment.findFirst({
        where: {
          studentId: student.id,
          sectionId: assignment.sectionSubject.sectionId,
          academicYearId: assignment.academicYearId,
          status: 'ACTIVE',
        } as any,
      });

      if (!enrolled) {
        throw new ForbiddenException(
          'Student not enrolled for this assignment',
        );
      }

      // Create submission if it doesn't exist
      const defaultKey = await this.s3.keyFor(
        assignment.schoolId,
        'submissions',
        actor.userId,
        'submission',
      );

      // Fetch assignment with createdByTeacher for consistency
      const assignmentWithTeacher = await (
        this.prisma as any
      ).assignment.findUnique({
        where: { id: assignmentId },
        include: {
          sectionSubject: {
            include: {
              section: true,
              subject: true,
            },
          },
          academicYear: true,
          createdByTeacher: true,
        },
      });

      submission = await (this.prisma as any).assignmentSubmission.create({
        data: {
          assignmentId: assignment.id,
          studentId: student.id,
          s3Key: defaultKey,
          status: 'UPLOADING',
        },
        include: {
          assignment: {
            include: {
              sectionSubject: {
                include: {
                  section: true,
                  subject: true,
                },
              },
              academicYear: true,
              createdByTeacher: true,
            },
          },
          student: true,
        },
      });

      // Replace assignment in submission with the one that includes createdByTeacher
      submission.assignment = assignmentWithTeacher;
    }

    // Validate submission matches assignment and student
    if (submission.assignmentId !== assignmentId) {
      throw new BadRequestException('Mismatched assignment');
    }
    if (submission.studentId !== student.id) {
      throw new ForbiddenException('Not allowed');
    }

    if (submission.status === 'MARKED') {
      throw new BadRequestException('Submission already marked');
    }

    // Ensure student is enrolled for that assignment
    const enrolled = await this.prisma.enrollment.findFirst({
      where: {
        studentId: student.id,
        sectionId: submission.assignment.sectionSubject.sectionId,
        academicYearId: submission.assignment.academicYearId,
        status: 'ACTIVE',
      } as any,
    });
    if (!enrolled)
      throw new ForbiddenException('Student not enrolled for this assignment');

    // Handle file uploads if provided
    const uploadedFiles = Array.isArray(files)
      ? files.filter((f) => f && f.buffer)
      : [];
    let s3Key = submission.s3Key;
    let fileName = submission.fileName;
    let mimeType = submission.mimeType;
    let sizeBytes = submission.sizeBytes;

    if (uploadedFiles.length > 0) {
      // Use the first file (for now, supporting single file submission)
      const file = uploadedFiles[0];
      assertPdfOnly({
        mimeType: file.mimetype,
        fileName: file.originalname,
        buffer: file.buffer as Buffer,
      });
      const safeName = (file.originalname ?? 'submission').replace(
        /[^a-zA-Z0-9._-]/g,
        '_',
      );
      // Server-proxied upload: compress images to KBs before storing.
      const compressed = await compressImage(
        file.buffer as Buffer,
        file.mimetype,
      );
      s3Key = await this.s3.keyFor(
        submission.assignment.schoolId,
        'submissions',
        actor.userId,
        safeName,
      );

      // Upload file to S3
      await this.s3.putObject({
        key: s3Key,
        body: compressed.buffer,
        contentType: compressed.mimeType,
        contentDisposition: file.originalname
          ? `attachment; filename="${safeName}"`
          : undefined,
      });

      fileName = file.originalname ?? null;
      mimeType = compressed.mimeType ?? null;
      sizeBytes = compressed.buffer.length;
    }

    const updatedSubmission = await (
      this.prisma as any
    ).assignmentSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'SUBMITTED',
        submittedAt: new Date(),
        s3Key,
        fileName,
        mimeType,
        sizeBytes,
      },
      include: {
        assignment: {
          include: {
            sectionSubject: {
              include: {
                section: true,
                subject: true,
              },
            },
            academicYear: true,
            createdByTeacher: true,
          },
        },
        student: true,
      },
    });

    // Generate download URL for the submission file
    let downloadUrl: string | null = null;
    if (updatedSubmission.s3Key) {
      try {
        const { url } = await this.s3.presignGetObject({
          key: updatedSubmission.s3Key,
        });
        downloadUrl = url;
      } catch (error) {
        console.error(
          `Failed to generate download URL for submission ${updatedSubmission.id}:`,
          error,
        );
      }
    }

    // Log: Student submitted assignment
    console.log('\n✅ [ASSIGNMENT SUBMITTED]');
    console.log(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    );
    console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
    console.log(`👤 Student ID: ${student.id}`);
    console.log(
      `👤 Student Name: ${updatedSubmission.student?.fullName || student.fullName || 'N/A'}`,
    );
    console.log(`📝 Assignment ID: ${assignmentId}`);
    console.log(
      `📝 Assignment Title: ${updatedSubmission.assignment?.title || submission.assignment.title}`,
    );
    console.log(
      `📁 Section: ${updatedSubmission.assignment?.sectionSubject?.section?.name || submission.assignment.sectionSubject.section?.name || 'N/A'}`,
    );
    console.log(
      `📚 Subject: ${updatedSubmission.assignment?.sectionSubject?.subject?.name || submission.assignment.sectionSubject.subject?.name || 'N/A'}`,
    );
    console.log(
      `📅 Academic Year: ${updatedSubmission.assignment?.academicYear?.name || submission.assignment.academicYear?.name || 'N/A'}`,
    );
    console.log(
      `👨‍🏫 Teacher: ${updatedSubmission.assignment?.createdByTeacher?.fullName || submission.assignment.createdByTeacher?.fullName || 'N/A'}`,
    );
    console.log(`📄 Submission ID: ${submissionId}`);
    console.log(
      `📎 File Name: ${updatedSubmission.fileName || submission.fileName || 'N/A'}`,
    );
    console.log(
      `📦 File Size: ${updatedSubmission.sizeBytes ? `${(updatedSubmission.sizeBytes / 1024).toFixed(2)} KB` : submission.sizeBytes ? `${(submission.sizeBytes / 1024).toFixed(2)} KB` : 'N/A'}`,
    );
    console.log(
      `🔖 MIME Type: ${updatedSubmission.mimeType || submission.mimeType || 'N/A'}`,
    );
    console.log(`☁️  S3 Key: ${updatedSubmission.s3Key || submission.s3Key}`);
    console.log(`📊 Status: SUBMITTED`);
    console.log(
      `🕐 Submitted At: ${updatedSubmission.submittedAt?.toISOString() || new Date().toISOString()}`,
    );
    console.log(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n',
    );

    // Notify the creator teacher that the student submitted.
    const teacherUserId =
      updatedSubmission.assignment?.createdByTeacher?.userId;
    if (teacherUserId) {
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds: [teacherUserId],
        type: 'ASSIGNMENT_SUBMITTED',
        title: 'Assignment submitted',
        body: `${updatedSubmission.student?.fullName ?? 'A student'} submitted "${updatedSubmission.assignment.title}".`,
        link: `/assignments/${assignmentId}/submissions`,
        notifyPreferenceKey: 'notifyGrades',
      } as NotificationCreateEvent);
    }

    return { ...updatedSubmission, downloadUrl };
  }

  async listSubmissions(assignmentId: string, actor: Actor) {
    this.ensureRole(actor, [Role.TEACHER]);

    const assignment = await (this.prisma as any).assignment.findUnique({
      where: { id: assignmentId },
      include: { sectionSubject: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    const teacher = await this.getTeacherOrThrow(actor, assignment.schoolId);
    if (assignment.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException('Only creator teacher can view submissions');
    }

    return (this.prisma as any).assignmentSubmission.findMany({
      where: { assignmentId },
      orderBy: { createdAt: 'desc' },
      include: {
        student: true,
      },
    });
  }

  async markSubmission(
    submissionId: string,
    dto: MarkSubmissionDto,
    actor: Actor,
  ) {
    this.ensureRole(actor, [Role.TEACHER]);

    const submission = await (
      this.prisma as any
    ).assignmentSubmission.findUnique({
      where: { id: submissionId },
      include: {
        assignment: {
          include: {
            sectionSubject: {
              include: {
                section: { include: { classGrade: true } },
                subject: true,
              },
            },
            academicYear: true,
            createdByTeacher: true,
          },
        },
        student: true,
      },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    // A teacher can mark a SUBMITTED submission and RE-mark an already MARKED
    // one (update grade/remarks); only in-flight UPLOADING can't be marked.
    if (!['SUBMITTED', 'MARKED'].includes(submission.status)) {
      throw new BadRequestException(
        `Cannot mark submission with status '${submission.status}'. Only submitted or already-marked submissions can be graded.`,
      );
    }

    // Validate assignment status - can only mark PUBLISHED or CLOSED assignments
    if (!['PUBLISHED', 'CLOSED'].includes(submission.assignment.status)) {
      throw new BadRequestException(
        `Cannot mark submissions for assignment with status '${submission.assignment.status}'. ` +
          `Only PUBLISHED or CLOSED assignments can have submissions marked.`,
      );
    }

    const teacher = await this.getTeacherOrThrow(
      actor,
      submission.assignment.schoolId,
    );
    if (submission.assignment.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException('Only creator teacher can mark');
    }

    // Require at least score or remarks
    if (
      dto.score === undefined &&
      (!dto.remarks || dto.remarks.trim() === '')
    ) {
      throw new BadRequestException('Either score or remarks must be provided');
    }

    const maxScore = submission.assignment.maxScore as number | null;
    if (dto.score !== undefined) {
      if (dto.score < 0) {
        throw new BadRequestException('Score cannot be negative');
      }
      if (maxScore !== null && dto.score > maxScore) {
        throw new BadRequestException(
          `Score (${dto.score}) cannot exceed maxScore (${maxScore})`,
        );
      }
    }

    const updated = await (this.prisma as any).assignmentSubmission.update({
      where: { id: submissionId },
      data: {
        ...(dto.score !== undefined && { score: dto.score }),
        ...(dto.remarks !== undefined && { remarks: dto.remarks ?? null }),
        status: 'MARKED',
        markedAt: new Date(),
      },
      include: {
        assignment: {
          include: {
            sectionSubject: {
              include: {
                section: { include: { classGrade: true } },
                subject: true,
              },
            },
            academicYear: true,
            createdByTeacher: true,
          },
        },
        student: true,
      },
    });

    // Submission counts (submitted vs marked) feed the dashboard — refresh after commit.
    await invalidateSchoolStats(this.cache, submission.assignment.schoolId);

    // Notify the student AND their parents that the submission was graded
    // (in-app + email per prefs). Decoupled via the event bus.
    if (updated.student?.userId) {
      const parents = await parentUserIds(this.prisma, [updated.studentId]);
      const event: NotificationCreateEvent = {
        userIds: [updated.student.userId, ...parents],
        type: 'ASSIGNMENT_GRADED',
        title: `Assignment graded: ${updated.assignment.title}`,
        body:
          dto.score !== undefined
            ? `Scored ${dto.score}${maxScore !== null ? `/${maxScore}` : ''} on "${updated.assignment.title}".`
            : `Submission for "${updated.assignment.title}" was reviewed.`,
        link: `/assignments/${updated.assignmentId}`,
        notifyPreferenceKey: 'notifyGrades',
      };
      this.eventEmitter.emit(NOTIFICATION_CREATE, event);
    }

    // Generate download URL for submission file
    let downloadUrl: string | null = null;
    if (updated.s3Key) {
      try {
        const { url } = await this.s3.presignGetObject({ key: updated.s3Key });
        downloadUrl = url;
      } catch (error) {
        console.error(
          `Failed to generate download URL for submission ${updated.id}:`,
          error,
        );
      }
    }

    return { ...updated, downloadUrl };
  }

  async results(
    assignmentId: string,
    actor: Actor,
    query?: { studentId?: string },
  ) {
    const assignment = await (this.prisma as any).assignment.findUnique({
      where: { id: assignmentId },
      include: {
        sectionSubject: { include: { section: true } },
        academicYear: true,
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    let targetStudentId: string;

    if (actor.role === Role.STUDENT) {
      // Students can only view results for PUBLISHED or CLOSED assignments
      if (!['PUBLISHED', 'CLOSED'].includes(assignment.status)) {
        throw new ForbiddenException(
          'Assignment is not published. Results are only available for published or closed assignments.',
        );
      }
      const student = await this.getStudentOrThrow(actor);
      targetStudentId = student.id;
      // Ignore studentId query param for students - they can only view their own results
    } else if (actor.role === Role.PARENT) {
      const parent = await this.getParentOrThrow(actor);
      if (!query?.studentId)
        throw new BadRequestException('studentId is required');
      await this.ensureChildOfParent(parent.id, query.studentId);
      targetStudentId = query.studentId;
    } else if (actor.role === Role.TEACHER) {
      const teacher = await this.getTeacherOrThrow(actor, assignment.schoolId);
      if (assignment.createdByTeacherId !== teacher.id) {
        throw new ForbiddenException('Only creator teacher can view results');
      }
      if (!query?.studentId)
        throw new BadRequestException('studentId is required');
      targetStudentId = query.studentId;
    } else {
      throw new ForbiddenException('Not allowed');
    }

    // Enrollment check (student must belong to this assignment)
    const enrolled = await this.prisma.enrollment.findFirst({
      where: {
        studentId: targetStudentId,
        sectionId: assignment.sectionSubject.sectionId,
        academicYearId: assignment.academicYearId,
        status: 'ACTIVE',
      } as any,
    });
    if (!enrolled) {
      throw new ForbiddenException(
        `Student not enrolled in section ${assignment.sectionSubject.section?.name || assignment.sectionSubject.sectionId} ` +
          `for academic year ${assignment.academicYear?.name || assignment.academicYearId}. ` +
          `Please ensure the student is enrolled in the correct section and academic year with ACTIVE status.`,
      );
    }

    const submission = await (
      this.prisma as any
    ).assignmentSubmission.findUnique({
      where: {
        assignmentId_studentId: {
          assignmentId,
          studentId: targetStudentId,
        },
      },
    });

    if (!submission) {
      return { assignmentId, studentId: targetStudentId, submission: null };
    }

    const { url: downloadUrl } = await this.s3.presignGetObject({
      key: submission.s3Key,
    });

    return {
      assignmentId,
      studentId: targetStudentId,
      submission: { ...submission, downloadUrl },
    };
  }

  async requestDownload(
    submissionId: string,
    actor: Actor,
    _query?: { studentId?: string },
  ) {
    const submission = await (
      this.prisma as any
    ).assignmentSubmission.findUnique({
      where: { id: submissionId },
      include: {
        assignment: {
          include: { sectionSubject: { include: { section: true } } },
        },
      },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    // Access: student owner, parent of student owner, or creator teacher of
    // the assignment.
    if (actor.role === Role.STUDENT) {
      const student = await this.getStudentOrThrow(actor);
      if (submission.studentId !== student.id)
        throw new ForbiddenException('Not allowed');
    } else if (actor.role === Role.PARENT) {
      const parent = await this.getParentOrThrow(actor);
      await this.ensureChildOfParent(parent.id, submission.studentId);
    } else if (actor.role === Role.TEACHER) {
      const teacher = await this.getTeacherOrThrow(
        actor,
        submission.assignment.schoolId,
      );
      if (submission.assignment.createdByTeacherId !== teacher.id) {
        throw new ForbiddenException('Not allowed');
      }
    } else {
      throw new ForbiddenException('Not allowed');
    }

    const { url } = await this.s3.presignGetObject({ key: submission.s3Key });
    return { submissionId: submission.id, downloadUrl: url };
  }

  private assignmentInclude(studentId?: string) {
    return {
      sectionSubject: {
        include: {
          section: { include: { classGrade: true } },
          subject: true,
          teacher: true,
        },
      },
      academicYear: true,
      createdByTeacher: true,
      attachments: {
        where: { status: AssignmentAttachmentStatus.READY },
        orderBy: { createdAt: Prisma.SortOrder.asc },
      },
      // For a STUDENT/PARENT list, fold in that student's own submission so the
      // client skips a per-row results call. orderBy makes take:1 deterministic.
      ...(studentId
        ? {
            submissions: {
              where: { studentId },
              orderBy: { createdAt: Prisma.SortOrder.desc },
              take: 1,
              select: {
                id: true,
                status: true,
                score: true,
                remarks: true,
                submittedAt: true,
              },
            },
          }
        : {}),
    };
  }

  private async enrichAttachmentsWithDownloadUrls(assignments: any[]) {
    const enriched = await Promise.all(
      assignments.map(async (assignment) => {
        if (!assignment.attachments || assignment.attachments.length === 0) {
          return assignment;
        }

        const attachmentsWithUrls = await Promise.all(
          assignment.attachments.map(async (attachment: any) => {
            if (attachment.status === 'READY' && attachment.s3Key) {
              try {
                const { url } = await this.s3.presignGetObject({
                  key: attachment.s3Key,
                });
                return { ...attachment, downloadUrl: url };
              } catch (error) {
                console.error(
                  `Failed to generate download URL for attachment ${attachment.id}:`,
                  error,
                );
                return attachment;
              }
            }
            return attachment;
          }),
        );

        return {
          ...assignment,
          attachments: attachmentsWithUrls,
        };
      }),
    );

    return enriched;
  }

  private ensureRole(actor: Actor, roles: Role[]) {
    if (!roles.includes(actor.role))
      throw new ForbiddenException('Not allowed');
  }

  private requireSchoolId(actor: Actor) {
    if (!actor.schoolId) throw new ForbiddenException('No school context');
    return actor.schoolId;
  }

  private async getTeacherOrThrow(actor: Actor, schoolId: string) {
    const teacher = await this.prisma.teacherProfile.findFirst({
      where: { userId: actor.userId, schoolId },
    });
    if (!teacher) throw new ForbiddenException('Teacher profile not found');
    return teacher;
  }

  private async getStudentOrThrow(actor: Actor) {
    const schoolId = this.requireSchoolId(actor);
    const student = await this.prisma.studentProfile.findFirst({
      where: { userId: actor.userId, schoolId },
    });
    if (!student) throw new ForbiddenException('Student profile not found');
    return student;
  }

  private async getParentOrThrow(actor: Actor) {
    const parent = await this.prisma.parentProfile.findFirst({
      where: { userId: actor.userId },
    });
    if (!parent) throw new ForbiddenException('Parent profile not found');
    return parent;
  }

  private async ensureChildOfParent(
    parentProfileId: string,
    studentProfileId: string,
  ) {
    const link = await (this.prisma as any).parentStudent.findUnique({
      where: {
        parentId_studentId: {
          parentId: parentProfileId,
          studentId: studentProfileId,
        },
      },
    });
    if (!link)
      throw new ForbiddenException('Student is not linked to this parent');
  }

  private async sectionSubjectIdsForStudent(
    studentId: string,
    academicYearId?: string,
  ) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        studentId,
        ...(academicYearId ? { academicYearId } : {}),
        status: 'ACTIVE',
      } as any,
      select: { sectionId: true },
    });

    const sectionIds = Array.from(new Set(enrollments.map((e) => e.sectionId)));
    if (sectionIds.length === 0) return [];

    const sectionSubjects = await (this.prisma as any).sectionSubject.findMany({
      where: { sectionId: { in: sectionIds } },
      select: { id: true },
    });

    return sectionSubjects.map((ss: any) => ss.id);
  }

  private async isTeacherAssignedToSectionSubject(input: {
    teacherId: string;
    sectionId: string;
    sectionSubjectTeacherId: string | null;
  }) {
    if (
      input.sectionSubjectTeacherId &&
      input.sectionSubjectTeacherId === input.teacherId
    ) {
      return true;
    }

    const st = await (this.prisma as any).sectionTeacher.findFirst({
      where: { sectionId: input.sectionId, teacherId: input.teacherId },
      select: { id: true },
    });

    return !!st;
  }

  private async enforceAssignmentAccess(
    assignment: any,
    actor: Actor,
    opts?: { studentId?: string },
  ) {
    if ([Role.SUPER_ADMIN, Role.SCHOOL_ADMIN].includes(actor.role)) {
      if (
        actor.role === Role.SCHOOL_ADMIN &&
        actor.schoolId !== assignment.schoolId
      ) {
        throw new ForbiddenException('Cross-school access denied');
      }
      return;
    }

    if (actor.role === Role.TEACHER) {
      const teacher = await this.getTeacherOrThrow(actor, assignment.schoolId);
      if (assignment.createdByTeacherId !== teacher.id) {
        throw new ForbiddenException('Not allowed');
      }
      return;
    }

    if (actor.role === Role.STUDENT) {
      if (!['PUBLISHED', 'CLOSED'].includes(assignment.status)) {
        throw new ForbiddenException(
          'Assignment is not published. Only PUBLISHED or CLOSED assignments are visible to students.',
        );
      }
      const student = await this.getStudentOrThrow(actor);
      const enrolled = await this.prisma.enrollment.findFirst({
        where: {
          studentId: student.id,
          sectionId: assignment.sectionSubject.sectionId,
          academicYearId: assignment.academicYearId,
          status: 'ACTIVE',
        } as any,
      });
      if (!enrolled) {
        throw new ForbiddenException(
          `Student not enrolled in section ${assignment.sectionSubject.section?.name || assignment.sectionSubject.sectionId} ` +
            `for academic year ${assignment.academicYear?.name || assignment.academicYearId}. ` +
            `Please ensure you are enrolled in the correct section and academic year.`,
        );
      }
      return;
    }

    if (actor.role === Role.PARENT) {
      if (!['PUBLISHED', 'CLOSED'].includes(assignment.status)) {
        throw new ForbiddenException('Assignment is not published');
      }
      const parent = await this.getParentOrThrow(actor);
      if (!opts?.studentId)
        throw new BadRequestException('studentId is required');
      await this.ensureChildOfParent(parent.id, opts.studentId);
      const enrolled = await this.prisma.enrollment.findFirst({
        where: {
          studentId: opts.studentId,
          sectionId: assignment.sectionSubject.sectionId,
          academicYearId: assignment.academicYearId,
          status: 'ACTIVE',
        } as any,
      });
      if (!enrolled)
        throw new ForbiddenException(
          'Student not enrolled for this assignment',
        );
      return;
    }

    throw new ForbiddenException('Not allowed');
  }
}
