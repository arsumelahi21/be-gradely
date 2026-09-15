import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { AuditLogService } from '../audit/audit.service';
import {
  assertPdfOnly,
  MAX_EXAM_PAPER_BYTES,
} from '../common/upload/attachment-rules';
import { ExamAccessService, ExamCore } from './exam-access.service';
import { paperIsEditable } from './exam-status';
import { safePaperFileName } from './exam-mappers';

export interface UploadedPaperFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/**
 * Confidential exam papers. Bytes live in ExamPaper (Postgres), never in S3, and leave only
 * through `read`, which re-authorizes every request. Students and parents never reach it.
 */
@Injectable()
export class ExamPapersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ExamAccessService,
    private readonly audit: AuditLogService,
  ) {}

  async upload(
    examinationId: string,
    subjectId: string,
    file: UploadedPaperFile | undefined,
    actor: Actor,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose a PDF file to upload');
    if (file.buffer.length > MAX_EXAM_PAPER_BYTES) {
      throw new BadRequestException('The exam paper must be 10 MB or smaller');
    }
    assertPdfOnly({ mimeType: file.mimetype, fileName: file.originalname, buffer: file.buffer });

    const exam = await this.access.loadCore(examinationId);
    await this.assertAuthor(actor, exam);
    await this.loadSubject(examinationId, subjectId);

    const fileName = safePaperFileName(file.originalname);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const bytes = new Uint8Array(file.buffer); // Prisma 6 Bytes fields take a plain Uint8Array
    const now = new Date();

    const replaced = await this.prisma.$transaction(async (tx) => {
      const guard = await tx.examination.updateMany({
        where: { id: examinationId, status: exam.status },
        data: { updatedAt: now },
      });
      if (!guard.count) throw new ConflictException('This examination changed. Reload and try again.');
      const existing = await tx.examPaper.findUnique({
        where: { examId: subjectId },
        select: { examId: true },
      });
      // Upsert overwrites the one row in place, so a replaced paper leaves no orphaned copy.
      await tx.examPaper.upsert({
        where: { examId: subjectId },
        create: {
          examId: subjectId,
          schoolId: exam.schoolId,
          data: bytes,
          fileName,
          sizeBytes: file.buffer.length,
          sha256,
          uploadedByUserId: actor.userId,
          uploadedAt: now,
        },
        update: {
          data: bytes,
          fileName,
          sizeBytes: file.buffer.length,
          sha256,
          uploadedByUserId: actor.userId,
          uploadedAt: now,
        },
      });
      await tx.examinationEvent.create({
        data: {
          examinationId,
          actorUserId: actor.userId,
          type: 'PAPER_UPLOADED',
          details: { subjectId, replaced: !!existing, sizeBytes: file.buffer.length },
        },
      });
      return !!existing;
    });

    void this.audit.record(actor.userId, replaced ? 'EXAM_PAPER_REPLACE' : 'EXAM_PAPER_UPLOAD', {
      schoolId: exam.schoolId,
      entityType: 'Examination',
      entityId: examinationId,
      metadata: { subjectId, sizeBytes: file.buffer.length, sha256 },
    });
    return { fileName, sizeBytes: file.buffer.length, uploadedAt: now, replaced };
  }

  async remove(examinationId: string, subjectId: string, actor: Actor) {
    const exam = await this.access.loadCore(examinationId);
    await this.assertAuthor(actor, exam);
    await this.loadSubject(examinationId, subjectId);

    const removed = await this.prisma.$transaction(async (tx) => {
      const guard = await tx.examination.updateMany({
        where: { id: examinationId, status: exam.status },
        data: { updatedAt: new Date() },
      });
      if (!guard.count) throw new ConflictException('This examination changed. Reload and try again.');
      const result = await tx.examPaper.deleteMany({ where: { examId: subjectId } });
      if (result.count) {
        await tx.examinationEvent.create({
          data: { examinationId, actorUserId: actor.userId, type: 'PAPER_REMOVED', details: { subjectId } },
        });
      }
      return result.count > 0;
    });
    if (!removed) throw new NotFoundException('No exam paper has been uploaded for this subject');

    void this.audit.record(actor.userId, 'EXAM_PAPER_REMOVE', {
      schoolId: exam.schoolId,
      entityType: 'Examination',
      entityId: examinationId,
      metadata: { subjectId },
    });
    return { removed: true };
  }

  /** Every read re-checks role, tenant, account state and authorship before touching the bytes. */
  async read(examinationId: string, subjectId: string, actor: Actor) {
    if (actor.role !== Role.SCHOOL_ADMIN && actor.role !== Role.TEACHER) {
      throw new ForbiddenException('Exam papers are only available to authorized staff');
    }
    const exam = await this.access.loadCore(examinationId);
    this.access.assertSameSchool(actor, exam.schoolId);

    const account = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { isActive: true },
    });
    if (!account?.isActive) throw new ForbiddenException('Account is inactive');

    if (actor.role === Role.TEACHER) {
      const teacherId = await this.access.teacherId(actor);
      if (!this.access.isCreator(actor, exam, teacherId)) {
        throw new ForbiddenException('Only the teacher who created this examination can open its paper');
      }
    }

    const paper = await this.prisma.examPaper.findFirst({
      where: { examId: subjectId, schoolId: exam.schoolId, exam: { examinationId } },
      select: { data: true, fileName: true, sizeBytes: true, sha256: true },
    });
    if (!paper) throw new NotFoundException('No exam paper has been uploaded for this subject');

    void this.audit.record(actor.userId, 'EXAM_PAPER_VIEW', {
      schoolId: exam.schoolId,
      entityType: 'Examination',
      entityId: examinationId,
      metadata: { subjectId, sha256: paper.sha256 },
    });
    return { data: Buffer.from(paper.data), fileName: paper.fileName };
  }

  /** Papers are managed by the examination's author while it is still theirs to change. */
  private async assertAuthor(actor: Actor, exam: ExamCore) {
    this.access.assertSameSchool(actor, exam.schoolId);
    const teacherId = actor.role === Role.TEACHER ? await this.access.teacherId(actor) : null;
    if (!this.access.isCreator(actor, exam, teacherId)) {
      throw new ForbiddenException(
        actor.role === Role.SCHOOL_ADMIN
          ? 'Request changes so the teacher uploads a revised paper'
          : 'Only the teacher who created this examination can change its paper',
      );
    }
    if (!paperIsEditable(exam.status)) {
      throw new ConflictException(
        exam.status === 'PENDING_REVIEW'
          ? 'The paper cannot be changed while the examination is waiting for review'
          : 'The paper can no longer be changed',
      );
    }
  }

  private async loadSubject(examinationId: string, subjectId: string) {
    const subject = await this.prisma.exam.findFirst({
      where: { id: subjectId, examinationId },
      select: { id: true },
    });
    if (!subject) throw new NotFoundException('Subject not found on this examination');
    return subject;
  }
}
