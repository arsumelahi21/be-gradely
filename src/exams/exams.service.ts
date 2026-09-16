import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ExaminationEventType,
  ExaminationStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/services/cache.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { AuditLogService } from '../audit/audit.service';
import {
  NOTIFICATION_CREATE,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import {
  schoolAdminUserIds,
  sectionYearStudentIds,
  studentUserIds,
} from '../common/notifications/recipients';
import {
  ExamAccessService,
  ExamCore,
  HISTORY_ENROLLMENT,
  TeacherSectionScope,
} from './exam-access.service';
import { ExamSettingsService } from './exam-settings.service';
import { percentOf } from './result-calculator';
import {
  adminCanEdit,
  canDelete,
  canEnterMarks,
  canFinalize,
  canReopen,
  nextStatus,
  paperIsEditable,
  ReviewAction,
  submissionProblems,
  teacherCanEdit,
  TERM_REQUIRED_MESSAGE,
} from './exam-status';
import {
  audienceExaminationSelect,
  cleanText,
  formatDate,
  formatMinutes,
  StaffExaminationRow,
  staffExaminationInclude,
  toAudienceExamination,
  toStaffExamination,
} from './exam-mappers';
import {
  CreateExaminationDto,
  ListExaminationsQueryDto,
  UpdateExaminationDto,
} from './dto/examination.dto';
import {
  CreateExamSubjectDto,
  ExamSubjectFieldsDto,
  UpdateExamSubjectDto,
} from './dto/exam-subject.dto';

type Db = Prisma.TransactionClient;

const staffListSelect = {
  id: true,
  title: true,
  status: true,
  resultStatus: true,
  reviewNote: true,
  className: true,
  sectionName: true,
  academicYearId: true,
  classGradeId: true,
  sectionId: true,
  submittedAt: true,
  publishedAt: true,
  finalizedAt: true,
  createdAt: true,
  updatedAt: true,
  academicYear: { select: { id: true, name: true } },
  term: { select: { id: true, name: true } },
  createdByTeacher: { select: { id: true, fullName: true } },
  createdByUser: { select: { fullName: true, role: true } },
  subjects: {
    orderBy: [{ heldAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      heldAt: true,
      startMin: true,
      endMin: true,
      venue: true,
      sectionSubject: { select: { subject: { select: { name: true } } } },
      paper: { select: { uploadedAt: true } },
    },
  },
} satisfies Prisma.ExaminationSelect;

function assertSubjectNumbers(v: {
  maxScore?: number | null;
  passingMarks?: number | null;
  startMin?: number | null;
  endMin?: number | null;
}) {
  if (
    v.maxScore != null &&
    v.passingMarks != null &&
    v.passingMarks > v.maxScore
  ) {
    throw new BadRequestException(
      'Passing marks cannot be more than total marks',
    );
  }
  if (v.startMin != null && v.endMin != null && v.endMin <= v.startMin) {
    throw new BadRequestException('End time must be after start time');
  }
}

@Injectable()
export class ExamsService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly access: ExamAccessService,
    private readonly settings: ExamSettingsService,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, cache);
  }

  // ---- Create / read ----

  async create(dto: CreateExaminationDto, actor: Actor) {
    const schoolId = this.access.schoolOf(actor);
    const teacherId =
      actor.role === Role.TEACHER ? await this.access.teacherId(actor) : null;
    const placement = await this.resolvePlacement(
      schoolId,
      dto.academicYearId,
      dto.classGradeId,
      dto.sectionId,
    );
    const scope = teacherId
      ? await this.assertTeacherInSection(teacherId, dto.sectionId)
      : null;
    const termId = await this.resolveTerm(
      schoolId,
      dto.academicYearId,
      dto.termId,
    );
    // A teacher may park a proposal without one; a principal picks the term up front.
    if (!teacherId) await this.assertTermChosen(dto.academicYearId, termId);
    const gradingSchemeId = dto.gradingSchemeId
      ? await this.resolveScheme(schoolId, dto.gradingSchemeId)
      : await this.settings.ensureDefaultScheme(schoolId);
    const subjects = await this.resolveNewSubjects(
      dto.subjects ?? [],
      dto.sectionId,
      scope,
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const exam = await tx.examination.create({
        data: {
          schoolId,
          academicYearId: dto.academicYearId,
          classGradeId: dto.classGradeId,
          sectionId: dto.sectionId,
          termId,
          gradingSchemeId,
          title: dto.title.trim(),
          instructions: cleanText(dto.instructions),
          className: placement.className,
          sectionName: placement.sectionName,
          createdByUserId: actor.userId,
          createdByTeacherId: teacherId,
        },
        select: { id: true },
      });
      for (const s of subjects) {
        await tx.exam.create({
          data: this.newSubjectData(
            exam.id,
            schoolId,
            dto.academicYearId,
            teacherId,
            s.input,
            s.label,
          ),
        });
      }
      await this.event(tx, exam.id, actor, 'CREATED', {
        toStatus: 'DRAFT',
        details: { subjects: subjects.length },
      });
      return exam;
    });

    void this.audit.record(actor.userId, 'EXAM_CREATE', {
      schoolId,
      entityType: 'Examination',
      entityId: created.id,
      metadata: { subjects: subjects.length },
    });
    return this.getStaff(created.id, actor, teacherId);
  }

  async list(actor: Actor, query: ListExaminationsQueryDto) {
    if (actor.role === Role.STUDENT || actor.role === Role.PARENT) {
      return this.listForAudience(actor, query);
    }

    const schoolId =
      actor.role === Role.SUPER_ADMIN
        ? query.schoolId
        : this.access.schoolOf(actor);
    if (!schoolId) throw new BadRequestException('schoolId is required');

    const and: Prisma.ExaminationWhereInput[] = [{ schoolId }];
    if (actor.role === Role.TEACHER) {
      and.push(
        this.access.teacherVisibility(await this.access.teacherId(actor)),
      );
    } else if (
      actor.role !== Role.SCHOOL_ADMIN &&
      actor.role !== Role.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Not allowed');
    }
    and.push(...this.commonFilters(query));
    if (query.status) and.push({ status: query.status });
    if (query.resultStatus) and.push({ resultStatus: query.resultStatus });
    if (query.teacherId) {
      and.push({
        OR: [
          { createdByTeacherId: query.teacherId },
          {
            subjects: {
              some: { sectionSubject: { teacherId: query.teacherId } },
            },
          },
        ],
      });
    }
    if (query.view === 'approvals') and.push({ submittedAt: { not: null } });

    const where: Prisma.ExaminationWhereInput = { AND: and };
    const orderBy: Prisma.ExaminationOrderByWithRelationInput[] =
      query.view === 'approvals'
        ? [{ submittedAt: 'desc' }, { createdAt: 'desc' }]
        : [{ createdAt: 'desc' }];

    const { page, pageSize, skip, take } = resolvePagination(query);
    const [rows, total, counts] = await Promise.all([
      this.prisma.examination.findMany({
        where,
        orderBy,
        skip,
        take,
        select: staffListSelect,
      }),
      this.prisma.examination.count({ where }),
      this.prisma.examination.groupBy({
        by: ['status'],
        where: { AND: and.filter((c) => !('status' in c)) },
        _count: { _all: true },
      }),
    ]);
    return {
      items: rows.map((r) => this.toStaffListRow(r)),
      total,
      page,
      pageSize,
      statusCounts: Object.fromEntries(
        counts.map((c) => [c.status, c._count._all]),
      ),
    };
  }

  async get(id: string, actor: Actor, studentId?: string) {
    const core = await this.access.loadCore(id);
    if (actor.role === Role.STUDENT || actor.role === Role.PARENT) {
      await this.access.assertAudienceCanView(actor, core, studentId);
      const row = await this.prisma.examination.findUniqueOrThrow({
        where: { id },
        select: audienceExaminationSelect,
      });
      return toAudienceExamination(row);
    }
    const teacherId = await this.access.assertStaffCanView(actor, core);
    return this.getStaff(id, actor, teacherId);
  }

  async history(id: string, actor: Actor) {
    const core = await this.access.loadCore(id);
    await this.access.assertStaffCanView(actor, core);
    return this.prisma.examinationEvent.findMany({
      where: { examinationId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        fromStatus: true,
        toStatus: true,
        reason: true,
        details: true,
        createdAt: true,
        // Teacher accounts often keep their name only on the profile.
        actor: {
          select: {
            fullName: true,
            role: true,
            teacherProfile: { select: { fullName: true } },
          },
        },
      },
    });
  }

  // ---- Edit ----

  async update(id: string, dto: UpdateExaminationDto, actor: Actor) {
    const core = await this.access.loadCore(id);
    const { teacherId, asAdmin } = await this.assertCanEditDetails(actor, core);
    const current = await this.prisma.examination.findUniqueOrThrow({
      where: { id },
      select: {
        title: true,
        instructions: true,
        termId: true,
        gradingSchemeId: true,
        _count: { select: { subjects: true } },
      },
    });

    const data: Prisma.ExaminationUncheckedUpdateManyInput = {};
    const changed: string[] = [];

    if (dto.title != null && dto.title.trim() !== current.title) {
      data.title = dto.title.trim();
      changed.push('title');
    }
    if (
      dto.instructions !== undefined &&
      cleanText(dto.instructions) !== current.instructions
    ) {
      data.instructions = cleanText(dto.instructions);
      changed.push('instructions');
    }

    const yearId = dto.academicYearId ?? core.academicYearId;
    const classGradeId = dto.classGradeId ?? core.classGradeId;
    const sectionId = dto.sectionId ?? core.sectionId;
    const placementChanged =
      yearId !== core.academicYearId ||
      classGradeId !== core.classGradeId ||
      sectionId !== core.sectionId;
    if (placementChanged) {
      if (current._count.subjects > 0) {
        throw new ConflictException(
          'Remove the subjects before changing the class, section or session',
        );
      }
      const placement = await this.resolvePlacement(
        core.schoolId,
        yearId,
        classGradeId,
        sectionId,
      );
      if (teacherId) await this.assertTeacherInSection(teacherId, sectionId);
      Object.assign(data, {
        academicYearId: yearId,
        classGradeId,
        sectionId,
        className: placement.className,
        sectionName: placement.sectionName,
      });
      changed.push('placement');
    }

    if (dto.termId !== undefined) {
      const termId = await this.resolveTerm(core.schoolId, yearId, dto.termId);
      if (termId !== current.termId) {
        data.termId = termId;
        changed.push('term');
      }
    } else if (yearId !== core.academicYearId && current.termId) {
      data.termId = null; // a term belongs to one session
      changed.push('term'); // or the early return below would drop the clearing
    }

    if (dto.gradingSchemeId !== undefined) {
      const schemeId = dto.gradingSchemeId
        ? await this.resolveScheme(core.schoolId, dto.gradingSchemeId)
        : await this.settings.ensureDefaultScheme(core.schoolId);
      if (schemeId !== current.gradingSchemeId) {
        data.gradingSchemeId = schemeId;
        changed.push('gradingScheme');
      }
    }

    if (!changed.length) return this.getStaff(id, actor, teacherId);

    const type: ExaminationEventType =
      asAdmin && core.createdByUserId !== actor.userId
        ? 'ADMIN_EDITED'
        : 'UPDATED';
    await this.prisma.$transaction(async (tx) => {
      await this.guardStatus(tx, id, core.status, data);
      await this.event(tx, id, actor, type, { details: { fields: changed } });
    });

    void this.audit.record(
      actor.userId,
      type === 'ADMIN_EDITED' ? 'EXAM_ADMIN_EDIT' : 'EXAM_UPDATE',
      {
        schoolId: core.schoolId,
        entityType: 'Examination',
        entityId: id,
        metadata: { fields: changed },
      },
    );
    return this.getStaff(id, actor, teacherId);
  }

  async remove(id: string, actor: Actor) {
    const core = await this.access.loadCore(id);
    this.access.assertSameSchool(actor, core.schoolId);
    if (actor.role === Role.TEACHER) {
      const teacherId = await this.access.teacherId(actor);
      if (!this.access.isCreator(actor, core, teacherId)) {
        throw new ForbiddenException(
          'Only the teacher who created this examination can delete it',
        );
      }
    }
    const hasMarks =
      (await this.prisma.examResult.count({
        where: { exam: { examinationId: id } },
      })) > 0;
    if (!canDelete(core.status, hasMarks)) {
      throw new ConflictException('Only a draft with no marks can be deleted');
    }
    const deleted = await this.prisma.examination.deleteMany({
      where: { id, status: 'DRAFT' },
    });
    if (!deleted.count)
      throw new ConflictException(
        'This examination changed. Reload and try again.',
      );

    void this.audit.record(actor.userId, 'EXAM_DELETE', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: id,
      metadata: { title: core.title },
    });
    return { deleted: true };
  }

  async addSubject(id: string, dto: CreateExamSubjectDto, actor: Actor) {
    const core = await this.access.loadCore(id);
    const { teacherId } = await this.assertCanEditDetails(actor, core);
    const scope = teacherId
      ? await this.access.teacherSectionScope(teacherId, core.sectionId)
      : null;
    const [subject] = await this.resolveNewSubjects(
      [dto],
      core.sectionId,
      scope,
    );
    const duplicate = await this.prisma.exam.findFirst({
      where: { examinationId: id, sectionSubjectId: dto.sectionSubjectId },
      select: { id: true },
    });
    if (duplicate)
      throw new ConflictException(
        `${subject.label} is already on this examination`,
      );

    await this.prisma.$transaction(async (tx) => {
      await this.guardStatus(tx, id, core.status);
      await tx.exam.create({
        data: this.newSubjectData(
          id,
          core.schoolId,
          core.academicYearId,
          teacherId,
          dto,
          subject.label,
        ),
      });
      await this.event(tx, id, actor, 'SUBJECT_ADDED', {
        details: { subject: subject.label },
      });
    });
    void this.audit.record(actor.userId, 'EXAM_SUBJECT_ADD', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: id,
      metadata: { subject: subject.label },
    });
    return this.getStaff(id, actor, teacherId);
  }

  async updateSubject(
    id: string,
    subjectId: string,
    dto: UpdateExamSubjectDto,
    actor: Actor,
  ) {
    const core = await this.access.loadCore(id);
    const { teacherId } = await this.assertCanEditDetails(actor, core);
    const subject = await this.prisma.exam.findFirst({
      where: { id: subjectId, examinationId: id },
      select: {
        id: true,
        maxScore: true,
        passingMarks: true,
        startMin: true,
        endMin: true,
        sectionSubject: {
          select: { id: true, subject: { select: { name: true } } },
        },
      },
    });
    if (!subject)
      throw new NotFoundException('Subject not found on this examination');
    if (teacherId) {
      const scope = await this.access.teacherSectionScope(
        teacherId,
        core.sectionId,
      );
      if (
        !scope.classTeacher &&
        !scope.sectionSubjectIds.has(subject.sectionSubject.id)
      ) {
        throw new ForbiddenException(
          `You do not teach ${subject.sectionSubject.subject.name} in this section`,
        );
      }
    }
    const merged = {
      maxScore: dto.maxScore !== undefined ? dto.maxScore : subject.maxScore,
      passingMarks:
        dto.passingMarks !== undefined
          ? dto.passingMarks
          : subject.passingMarks,
      startMin: dto.startMin !== undefined ? dto.startMin : subject.startMin,
      endMin: dto.endMin !== undefined ? dto.endMin : subject.endMin,
    };
    assertSubjectNumbers(merged);
    const data = this.subjectFieldData(dto);
    const fields = Object.keys(data);
    if (!fields.length) return this.getStaff(id, actor, teacherId);

    await this.prisma.$transaction(async (tx) => {
      await this.guardStatus(tx, id, core.status);
      await tx.exam.update({ where: { id: subjectId }, data });
      await this.event(tx, id, actor, 'SUBJECT_UPDATED', {
        details: { subject: subject.sectionSubject.subject.name, fields },
      });
    });
    void this.audit.record(actor.userId, 'EXAM_SUBJECT_UPDATE', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: id,
      metadata: { subjectId, fields },
    });
    return this.getStaff(id, actor, teacherId);
  }

  async removeSubject(id: string, subjectId: string, actor: Actor) {
    const core = await this.access.loadCore(id);
    const { teacherId } = await this.assertCanEditDetails(actor, core);
    const subject = await this.prisma.exam.findFirst({
      where: { id: subjectId, examinationId: id },
      select: {
        id: true,
        sectionSubject: {
          select: { id: true, subject: { select: { name: true } } },
        },
        _count: { select: { results: true } },
      },
    });
    if (!subject)
      throw new NotFoundException('Subject not found on this examination');
    if (subject._count.results)
      throw new ConflictException(
        'This subject already has marks and cannot be removed',
      );
    if (teacherId) {
      const scope = await this.access.teacherSectionScope(
        teacherId,
        core.sectionId,
      );
      if (
        !scope.classTeacher &&
        !scope.sectionSubjectIds.has(subject.sectionSubject.id)
      ) {
        throw new ForbiddenException(
          `You do not teach ${subject.sectionSubject.subject.name} in this section`,
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await this.guardStatus(tx, id, core.status);
      await tx.exam.delete({ where: { id: subjectId } });
      await this.event(tx, id, actor, 'SUBJECT_REMOVED', {
        details: { subject: subject.sectionSubject.subject.name },
      });
    });
    void this.audit.record(actor.userId, 'EXAM_SUBJECT_REMOVE', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: id,
      metadata: { subjectId },
    });
    return this.getStaff(id, actor, teacherId);
  }

  // ---- Review workflow ----

  async submit(id: string, actor: Actor) {
    const core = await this.access.loadCore(id);
    this.access.assertSameSchool(actor, core.schoolId);
    const teacherId = await this.access.teacherId(actor);
    if (!this.access.isCreator(actor, core, teacherId)) {
      throw new ForbiddenException(
        'Only the teacher who created this examination can send it for review',
      );
    }
    const to = nextStatus(core.status, 'SUBMIT', { teacherAuthored: true });
    if (!to)
      throw new ConflictException(
        this.transitionMessage(core.status, 'SUBMIT'),
      );
    // A teacher must choose only once the session actually has terms to choose from.
    await this.assertComplete(id, {
      requireTerm: await this.hasTerms(core.academicYearId),
    });

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.guardStatus(tx, id, core.status, {
        status: to,
        submittedAt: now,
        reviewNote: null,
      });
      await this.event(tx, id, actor, 'SUBMITTED', {
        fromStatus: core.status,
        toStatus: to,
      });
    });

    await this.notifyReviewers(core, actor);
    void this.audit.record(actor.userId, 'EXAM_SUBMIT', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: id,
    });
    return this.getStaff(id, actor, teacherId);
  }

  async requestChanges(id: string, reason: string, actor: Actor) {
    return this.review(id, 'REQUEST_CHANGES', reason, actor);
  }

  async reject(id: string, reason: string, actor: Actor) {
    return this.review(id, 'REJECT', reason, actor);
  }

  async publish(id: string, actor: Actor) {
    const core = await this.access.loadCore(id);
    this.access.assertSameSchool(actor, core.schoolId);
    const to = nextStatus(core.status, 'PUBLISH', {
      teacherAuthored: !!core.createdByTeacherId,
    });
    if (!to)
      throw new ConflictException(
        this.transitionMessage(core.status, 'PUBLISH'),
      );
    // The principal owns the term decision, so it is demanded, never inferred.
    await this.assertTermChosen(core.academicYearId, core.termId);
    await this.assertComplete(id, { requireTerm: true });

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.guardStatus(tx, id, core.status, {
        status: to,
        publishedAt: now,
        reviewedAt: now,
        reviewedByUserId: actor.userId,
        reviewNote: null,
      });
      await this.event(tx, id, actor, 'PUBLISHED', {
        fromStatus: core.status,
        toStatus: to,
      });
    });

    // Notifications only after the commit, so nobody hears about an exam that rolled back.
    await this.notifyPublished(id, actor);
    void this.audit.record(actor.userId, 'EXAM_PUBLISH', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: id,
    });
    return this.getStaff(id, actor, null);
  }

  private async review(
    id: string,
    action: 'REQUEST_CHANGES' | 'REJECT',
    reason: string,
    actor: Actor,
  ) {
    const trimmed = reason?.trim();
    if (!trimmed) {
      throw new BadRequestException(
        action === 'REJECT'
          ? 'Give a reason for rejecting this examination'
          : 'Tell the teacher what needs to change',
      );
    }
    const core = await this.access.loadCore(id);
    this.access.assertSameSchool(actor, core.schoolId);
    const to = nextStatus(core.status, action, {
      teacherAuthored: !!core.createdByTeacherId,
    });
    if (!to)
      throw new ConflictException(this.transitionMessage(core.status, action));

    await this.prisma.$transaction(async (tx) => {
      await this.guardStatus(tx, id, core.status, {
        status: to,
        reviewNote: trimmed,
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId,
      });
      await this.event(
        tx,
        id,
        actor,
        action === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED',
        {
          fromStatus: core.status,
          toStatus: to,
          reason: trimmed,
        },
      );
    });

    if (core.createdByUserId && core.createdByUserId !== actor.userId) {
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds: [core.createdByUserId],
        type: action === 'REJECT' ? 'EXAM_REJECTED' : 'EXAM_CHANGES_REQUESTED',
        title:
          action === 'REJECT' ? 'Examination rejected' : 'Changes requested',
        body: `"${core.title}": ${trimmed}`,
        link: `/examinations/${id}`,
        entityType: 'Examination',
        entityId: id,
        notifyPreferenceKey: 'notifyGrades',
      } as NotificationCreateEvent);
    }
    void this.audit.record(
      actor.userId,
      action === 'REJECT' ? 'EXAM_REJECT' : 'EXAM_CHANGES_REQUESTED',
      {
        schoolId: core.schoolId,
        entityType: 'Examination',
        entityId: id,
      },
    );
    return this.getStaff(id, actor, null);
  }

  // ---- Stats (school dashboard) ----

  /** School-wide average across FINALIZED results only — provisional marks never reach the dashboard. */
  async getSchoolStats(actor: Actor, opts?: { schoolId?: string }) {
    if (actor.role !== Role.SUPER_ADMIN && actor.role !== Role.SCHOOL_ADMIN) {
      throw new ForbiddenException('Not allowed');
    }
    const schoolId =
      actor.role === Role.SUPER_ADMIN ? opts?.schoolId : actor.schoolId;
    if (!schoolId) throw new BadRequestException('schoolId is required');
    return this.cache!.wrap(`exams:school-stats:${schoolId}`, 60, () =>
      this.computeSchoolStats(schoolId),
    );
  }

  private async computeSchoolStats(schoolId: string) {
    const [row] = await this.prisma.$queryRaw<
      Array<{
        gradedResults: number;
        obtained: number | null;
        total: number | null;
      }>
    >`
      SELECT COUNT(*)::int AS "gradedResults",
             SUM(CASE WHEN er."isAbsent" THEN 0 ELSE er.score END)::int AS obtained,
             SUM(e."maxScore")::int AS total
      FROM "ExamResult" er
      JOIN "Exam" e ON e.id = er."examId"
      JOIN "Examination" x ON x.id = e."examinationId"
      WHERE e."schoolId" = ${schoolId}
        AND x."resultStatus" = 'FINALIZED'
        AND (er.score IS NOT NULL OR er."isAbsent")
        AND e."maxScore" > 0
    `;
    const gradedResults = row?.gradedResults ?? 0;
    // Σobtained / Σtotal through the engine: a mean of paper percentages would let a 20-mark
    // quiz weigh as much as a 100-mark paper, and dropped absences inflated it.
    const averageScorePercent =
      gradedResults === 0 || row?.total == null
        ? null
        : percentOf(row.obtained ?? 0, row.total);
    const examCount = await this.prisma.examination.count({
      where: { schoolId, status: 'PUBLISHED' },
    });
    return { schoolId, examCount, gradedResults, averageScorePercent };
  }

  // ---- Helpers ----

  private async getStaff(id: string, actor: Actor, teacherId: string | null) {
    const row = await this.prisma.examination.findUniqueOrThrow({
      where: { id },
      include: staffExaminationInclude,
    });
    return {
      ...toStaffExamination(row),
      permissions: await this.permissionsFor(actor, row, teacherId),
    };
  }

  /** UI hints only — every action re-checks these on the server. */
  private async permissionsFor(
    actor: Actor,
    row: StaffExaminationRow,
    teacherId: string | null,
  ) {
    const isAdmin = actor.role === Role.SCHOOL_ADMIN;
    const creator = this.access.isCreator(actor, row, teacherId);
    const teacherAuthored = !!row.createdByTeacherId;
    const hasMarks = row.subjects.some((s) => s._count.results > 0);
    const teachesAny =
      !!teacherId &&
      (row.createdByTeacherId === teacherId ||
        row.subjects.some(
          (s) =>
            s.sectionSubject.teacherId === teacherId ||
            s.createdByTeacherId === teacherId,
        ));
    const classTeacher = teacherId
      ? await this.access.isClassTeacher(teacherId, row.sectionId)
      : false;
    const staffTeacher = actor.role === Role.TEACHER;
    return {
      canEdit: isAdmin
        ? adminCanEdit(row.status)
        : staffTeacher && creator && teacherCanEdit(row.status),
      canDelete:
        (isAdmin || (staffTeacher && creator)) &&
        canDelete(row.status, hasMarks),
      canManagePaper:
        (isAdmin || staffTeacher) && creator && paperIsEditable(row.status),
      canViewPaper: isAdmin || (staffTeacher && creator),
      canSubmit:
        staffTeacher &&
        creator &&
        nextStatus(row.status, 'SUBMIT', { teacherAuthored: true }) !== null,
      canReview: isAdmin && row.status === 'PENDING_REVIEW',
      canPublish:
        isAdmin &&
        nextStatus(row.status, 'PUBLISH', { teacherAuthored }) !== null,
      canEnterMarks:
        canEnterMarks(row.status, row.resultStatus) && (isAdmin || teachesAny),
      canEditRemarks:
        row.status === 'PUBLISHED' &&
        row.resultStatus !== 'FINALIZED' &&
        (isAdmin || classTeacher),
      canFinalize: isAdmin && canFinalize(row.status, row.resultStatus),
      canReopen: isAdmin && canReopen(row.resultStatus),
    };
  }

  private async assertCanEditDetails(actor: Actor, core: ExamCore) {
    this.access.assertSameSchool(actor, core.schoolId);
    if (actor.role === Role.SCHOOL_ADMIN) {
      if (!adminCanEdit(core.status)) {
        throw new ConflictException(
          'A published or rejected examination can no longer be edited',
        );
      }
      return { teacherId: null, asAdmin: true };
    }
    if (actor.role === Role.TEACHER) {
      const teacherId = await this.access.teacherId(actor);
      if (!this.access.isCreator(actor, core, teacherId)) {
        throw new ForbiddenException(
          'Only the teacher who created this examination can edit it',
        );
      }
      if (!teacherCanEdit(core.status)) {
        throw new ConflictException(
          core.status === 'PENDING_REVIEW'
            ? 'This examination is waiting for review and cannot be edited'
            : 'This examination can no longer be edited',
        );
      }
      return { teacherId, asAdmin: false };
    }
    throw new ForbiddenException('Not allowed');
  }

  /** Conditional write: fails with 409 if someone else moved the exam since we read it. */
  private async guardStatus(
    tx: Db,
    id: string,
    expected: ExaminationStatus,
    data: Prisma.ExaminationUncheckedUpdateManyInput = {},
  ) {
    const result = await tx.examination.updateMany({
      where: { id, status: expected },
      data: { ...data, updatedAt: new Date() },
    });
    if (!result.count) {
      throw new ConflictException(
        'This examination changed while you were working. Reload and try again.',
      );
    }
  }

  private event(
    tx: Db,
    examinationId: string,
    actor: Actor,
    type: ExaminationEventType,
    extra: {
      fromStatus?: ExaminationStatus;
      toStatus?: ExaminationStatus;
      reason?: string;
      details?: Prisma.InputJsonValue;
    } = {},
  ) {
    return tx.examinationEvent.create({
      data: { examinationId, actorUserId: actor.userId, type, ...extra },
    });
  }

  private async assertComplete(id: string, opts: { requireTerm: boolean }) {
    const exam = await this.prisma.examination.findUniqueOrThrow({
      where: { id },
      select: {
        title: true,
        academicYearId: true,
        classGradeId: true,
        sectionId: true,
        termId: true,
        subjects: {
          select: {
            heldAt: true,
            startMin: true,
            endMin: true,
            maxScore: true,
            passingMarks: true,
            sectionSubject: { select: { subject: { select: { name: true } } } },
            paper: { select: { uploadedAt: true } },
          },
        },
      },
    });
    const problems = submissionProblems(
      {
        title: exam.title,
        academicYearId: exam.academicYearId,
        classGradeId: exam.classGradeId,
        sectionId: exam.sectionId,
        termId: exam.termId,
        subjects: exam.subjects.map((s) => ({
          label: s.sectionSubject.subject.name,
          heldAt: s.heldAt,
          startMin: s.startMin,
          endMin: s.endMin,
          maxScore: s.maxScore,
          passingMarks: s.passingMarks,
          hasPaper: !!s.paper,
        })),
      },
      opts,
    );
    if (problems.length) {
      throw new BadRequestException({
        statusCode: 400,
        message: `Complete the examination first: ${problems[0]}`,
        problems,
      });
    }
  }

  private transitionMessage(
    status: ExaminationStatus,
    action: ReviewAction,
  ): string {
    if (action === 'SUBMIT') {
      return status === 'PENDING_REVIEW'
        ? 'This examination is already waiting for review'
        : 'This examination can no longer be sent for review';
    }
    if (action === 'PUBLISH' && status === 'DRAFT') {
      return 'The teacher has not sent this examination for review yet';
    }
    if (status === 'PUBLISHED') return 'This examination is already published';
    if (status === 'REJECTED') return 'This examination was rejected';
    return 'Only an examination waiting for review can be reviewed';
  }

  private async resolvePlacement(
    schoolId: string,
    academicYearId: string,
    classGradeId: string,
    sectionId: string,
  ) {
    const [year, section] = await Promise.all([
      this.prisma.academicYear.findUnique({
        where: { id: academicYearId },
        select: { schoolId: true },
      }),
      this.prisma.section.findUnique({
        where: { id: sectionId },
        select: {
          schoolId: true,
          name: true,
          classGradeId: true,
          classGrade: { select: { name: true } },
        },
      }),
    ]);
    if (!year || year.schoolId !== schoolId) {
      throw new BadRequestException(
        'Choose an academic session from your school',
      );
    }
    if (!section || section.schoolId !== schoolId) {
      throw new BadRequestException('Choose a section from your school');
    }
    if (section.classGradeId !== classGradeId) {
      throw new BadRequestException(
        'That section does not belong to the selected class',
      );
    }
    return { className: section.classGrade.name, sectionName: section.name };
  }

  private async assertTeacherInSection(teacherId: string, sectionId: string) {
    const scope = await this.access.teacherSectionScope(teacherId, sectionId);
    if (!scope.classTeacher && scope.sectionSubjectIds.size === 0) {
      throw new ForbiddenException('You are not assigned to this section');
    }
    return scope;
  }

  private async resolveTerm(
    schoolId: string,
    academicYearId: string,
    termId?: string | null,
  ) {
    if (!termId) return null;
    const term = await this.prisma.academicTerm.findUnique({
      where: { id: termId },
      select: { schoolId: true, academicYearId: true },
    });
    if (
      !term ||
      term.schoolId !== schoolId ||
      term.academicYearId !== academicYearId
    ) {
      throw new BadRequestException(
        'Choose a term from the selected academic session',
      );
    }
    return termId;
  }

  /** Whether the session has any term at all, i.e. whether a choice even exists. */
  private async hasTerms(academicYearId: string): Promise<boolean> {
    return (
      (await this.prisma.academicTerm.count({ where: { academicYearId } })) > 0
    );
  }

  /**
   * Refuses a missing term instead of picking one — never the current, latest or first.
   * Says something different when the session has no term to choose yet.
   */
  private async assertTermChosen(
    academicYearId: string,
    termId: string | null,
  ): Promise<void> {
    if (termId) return;
    throw new BadRequestException(
      (await this.hasTerms(academicYearId))
        ? TERM_REQUIRED_MESSAGE
        : 'This academic session has no terms yet. Add one under Terms & grading first.',
    );
  }

  private async resolveScheme(schoolId: string, schemeId: string) {
    const scheme = await this.prisma.gradingScheme.findUnique({
      where: { id: schemeId },
      select: { schoolId: true },
    });
    if (!scheme || scheme.schoolId !== schoolId) {
      throw new BadRequestException('Choose a grading scheme from your school');
    }
    return schemeId;
  }

  private async resolveNewSubjects(
    inputs: CreateExamSubjectDto[],
    sectionId: string,
    scope: TeacherSectionScope | null,
  ) {
    const ids = inputs.map((s) => s.sectionSubjectId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each subject can only be added once');
    }
    if (!ids.length) return [];
    const rows = await this.prisma.sectionSubject.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        sectionId: true,
        subject: { select: { name: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return inputs.map((input) => {
      const ss = byId.get(input.sectionSubjectId);
      if (!ss || ss.sectionId !== sectionId) {
        throw new BadRequestException(
          'That subject is not taught in this section',
        );
      }
      if (scope && !scope.classTeacher && !scope.sectionSubjectIds.has(ss.id)) {
        throw new ForbiddenException(
          `You do not teach ${ss.subject.name} in this section`,
        );
      }
      assertSubjectNumbers(input);
      return { input, label: ss.subject.name };
    });
  }

  private newSubjectData(
    examinationId: string,
    schoolId: string,
    academicYearId: string,
    teacherId: string | null,
    input: CreateExamSubjectDto,
    label: string,
  ): Prisma.ExamUncheckedCreateInput {
    return {
      examinationId,
      schoolId,
      academicYearId,
      sectionSubjectId: input.sectionSubjectId,
      createdByTeacherId: teacherId,
      title: label,
      ...this.subjectFieldData(input),
    };
  }

  private subjectFieldData(input: ExamSubjectFieldsDto) {
    const data: Prisma.ExamUncheckedUpdateInput = {};
    if (input.heldAt !== undefined)
      data.heldAt = input.heldAt ? new Date(input.heldAt) : null;
    if (input.startMin !== undefined) data.startMin = input.startMin;
    if (input.endMin !== undefined) data.endMin = input.endMin;
    if (input.venue !== undefined) data.venue = cleanText(input.venue);
    if (input.maxScore !== undefined) data.maxScore = input.maxScore;
    if (input.passingMarks !== undefined)
      data.passingMarks = input.passingMarks;
    if (input.description !== undefined)
      data.description = cleanText(input.description);
    return data as Record<string, never>;
  }

  private commonFilters(
    query: ListExaminationsQueryDto,
  ): Prisma.ExaminationWhereInput[] {
    const and: Prisma.ExaminationWhereInput[] = [];
    if (query.q?.trim())
      and.push({ title: { contains: query.q.trim(), mode: 'insensitive' } });
    if (query.academicYearId)
      and.push({ academicYearId: query.academicYearId });
    if (query.classGradeId) and.push({ classGradeId: query.classGradeId });
    if (query.sectionId) and.push({ sectionId: query.sectionId });
    if (query.termId) and.push({ termId: query.termId });
    if (query.from || query.to) {
      and.push({
        subjects: {
          some: {
            heldAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          },
        },
      });
    }
    return and;
  }

  private async listForAudience(actor: Actor, query: ListExaminationsQueryDto) {
    const studentId = await this.access.resolveAudienceStudent(
      actor,
      query.studentId,
    );
    const placements = await this.prisma.enrollment.findMany({
      where: { studentId, status: { in: HISTORY_ENROLLMENT } },
      select: { sectionId: true, academicYearId: true },
    });
    const { page, pageSize, skip, take } = resolvePagination(query);
    if (!placements.length) return { items: [], total: 0, page, pageSize };

    const where: Prisma.ExaminationWhereInput = {
      AND: [
        { status: 'PUBLISHED' },
        {
          OR: placements.map((p) => ({
            sectionId: p.sectionId,
            academicYearId: p.academicYearId,
          })),
        },
        ...this.commonFilters(query),
        ...(query.resultStatus ? [{ resultStatus: query.resultStatus }] : []),
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.examination.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        select: audienceExaminationSelect,
      }),
      this.prisma.examination.count({ where }),
    ]);
    return { items: rows.map(toAudienceExamination), total, page, pageSize };
  }

  private toStaffListRow(
    r: Prisma.ExaminationGetPayload<{ select: typeof staffListSelect }>,
  ) {
    const dates = r.subjects.map((s) => s.heldAt).filter((d): d is Date => !!d);
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      resultStatus: r.resultStatus,
      reviewNote: r.reviewNote,
      className: r.className,
      sectionName: r.sectionName,
      academicYearId: r.academicYearId,
      classGradeId: r.classGradeId,
      sectionId: r.sectionId,
      academicYear: r.academicYear,
      term: r.term,
      teacher: r.createdByTeacher,
      createdByName:
        r.createdByTeacher?.fullName ?? r.createdByUser?.fullName ?? null,
      submittedAt: r.submittedAt,
      publishedAt: r.publishedAt,
      finalizedAt: r.finalizedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      subjectNames: r.subjects.map((s) => s.sectionSubject.subject.name),
      subjectCount: r.subjects.length,
      papersUploaded: r.subjects.filter((s) => !!s.paper).length,
      firstDate: dates.length ? dates[0] : null,
      lastDate: dates.length ? dates[dates.length - 1] : null,
    };
  }

  private async notifyReviewers(core: ExamCore, actor: Actor) {
    const admins = await schoolAdminUserIds(this.prisma, core.schoolId);
    if (!admins.length) return;
    const teacher = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: {
        fullName: true,
        teacherProfile: { select: { fullName: true } },
      },
    });
    const by = teacher?.teacherProfile?.fullName ?? teacher?.fullName;
    this.eventEmitter.emit(NOTIFICATION_CREATE, {
      userIds: admins,
      type: 'EXAM_SUBMITTED',
      title: 'Examination waiting for review',
      body: `"${core.title}" · ${core.className} ${core.sectionName}${by ? ` · from ${by}` : ''}`,
      link: `/examinations/${core.id}`,
      entityType: 'Examination',
      entityId: core.id,
      notifyPreferenceKey: 'notifyGrades',
    } as NotificationCreateEvent);
  }

  /** Examination details only — no paper, paper link or file reference ever goes into a notification. */
  private async notifyPublished(id: string, actor: Actor) {
    const exam = await this.prisma.examination.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        title: true,
        className: true,
        sectionName: true,
        sectionId: true,
        academicYearId: true,
        createdByUserId: true,
        subjects: {
          orderBy: [{ heldAt: 'asc' }, { createdAt: 'asc' }],
          select: {
            heldAt: true,
            startMin: true,
            endMin: true,
            venue: true,
            sectionSubject: { select: { subject: { select: { name: true } } } },
          },
        },
      },
    });

    const schedule = exam.subjects.slice(0, 3).map((s) => {
      const time =
        s.startMin != null
          ? `${formatMinutes(s.startMin)}${s.endMin != null ? `–${formatMinutes(s.endMin)}` : ''}`
          : null;
      return [
        s.sectionSubject.subject.name,
        formatDate(s.heldAt),
        time,
        s.venue,
      ]
        .filter(Boolean)
        .join(' · ');
    });
    const more =
      exam.subjects.length > 3 ? `; +${exam.subjects.length - 3} more` : '';
    const studentIds = await sectionYearStudentIds(
      this.prisma,
      exam.sectionId,
      exam.academicYearId,
    );
    const userIds = await studentUserIds(this.prisma, studentIds);
    if (userIds.length) {
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds,
        type: 'EXAM_PUBLISHED',
        title: `New examination: ${exam.title}`,
        body: `${exam.className} ${exam.sectionName} — ${schedule.join('; ')}${more}`,
        link: `/exams/${exam.id}`,
        entityType: 'Examination',
        entityId: exam.id,
        notifyPreferenceKey: 'notifyGrades',
      } as NotificationCreateEvent);
    }

    if (exam.createdByUserId && exam.createdByUserId !== actor.userId) {
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds: [exam.createdByUserId],
        type: 'EXAM_APPROVED',
        title: 'Examination approved',
        body: `Your examination proposal "${exam.title}" has been approved and published.`,
        link: `/examinations/${exam.id}`,
        entityType: 'Examination',
        entityId: exam.id,
        notifyPreferenceKey: 'notifyGrades',
      } as NotificationCreateEvent);
    }
  }
}
