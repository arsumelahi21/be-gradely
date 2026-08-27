import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { CacheService } from '../common/services/cache.service';
import { invalidateSchoolStats } from '../common/cache/stats-cache';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { CreateExamDto } from './dto/create-exam.dto';
import { UpdateExamDto } from './dto/update-exam.dto';
import { MarkExamResultDto } from './dto/mark-exam-result.dto';
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

@Injectable()
export class ExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
  ) {}

  async create(dto: CreateExamDto, actor: Actor) {
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

    return (this.prisma as any).exam.create({
      data: {
        schoolId,
        academicYearId: dto.academicYearId,
        sectionSubjectId: dto.sectionSubjectId,
        createdByTeacherId: teacher.id,
        title: dto.title,
        description: dto.description ?? null,
        heldAt: dto.heldAt ? new Date(dto.heldAt) : null,
        maxScore: dto.maxScore ?? null,
      },
      include: this.examInclude(),
    });
  }

  async list(
    actor: Actor,
    query: {
      academicYearId?: string;
      sectionSubjectId?: string;
      studentId?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const role = actor.role;
    let where: any;
    // For STUDENT/PARENT, the one student whose result we fold into the list.
    let targetStudentId: string | undefined;

    if ([Role.SUPER_ADMIN, Role.SCHOOL_ADMIN].includes(role)) {
      const schoolId =
        role === Role.SUPER_ADMIN
          ? (actor.schoolId ?? undefined)
          : actor.schoolId!;
      where = {};
      if (role === Role.SCHOOL_ADMIN) where.schoolId = actor.schoolId!;
      if (schoolId) where.schoolId = schoolId;
      if (query.academicYearId) where.academicYearId = query.academicYearId;
      if (query.sectionSubjectId)
        where.sectionSubjectId = query.sectionSubjectId;
    } else if (role === Role.TEACHER) {
      const schoolId = this.requireSchoolId(actor);
      const teacher = await this.prisma.teacherProfile.findFirst({
        where: { userId: actor.userId, schoolId },
      });
      if (!teacher) throw new ForbiddenException('Teacher profile not found');
      where = { schoolId, createdByTeacherId: teacher.id };
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

    const include = this.examInclude({ studentId: targetStudentId });
    const orderBy = { createdAt: 'desc' as const };

    // Backward-compatible: plain array unless `page` is supplied.
    if (query.page == null) {
      return (this.prisma as any).exam.findMany({ where, orderBy, include });
    }

    const { page, pageSize, skip, take } = resolvePagination(query);
    const [items, total] = await Promise.all([
      (this.prisma as any).exam.findMany({
        where,
        orderBy,
        include,
        skip,
        take,
      }),
      (this.prisma as any).exam.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * Schoolwide average exam score % across graded results — mean of
   * (score/maxScore) where maxScore > 0; empty set → null.
   */
  async getSchoolStats(actor: Actor, opts?: { schoolId?: string }) {
    this.ensureRole(actor, [Role.SUPER_ADMIN, Role.SCHOOL_ADMIN]);
    const schoolId =
      actor.role === Role.SUPER_ADMIN ? opts?.schoolId : actor.schoolId;
    if (!schoolId) throw new BadRequestException('schoolId is required');
    // ponytail: 60s TTL, no write-invalidation — stats tolerate <60s staleness.
    return this.cache.wrap(`exams:school-stats:${schoolId}`, 60, () =>
      this.computeSchoolStats(schoolId),
    );
  }

  private async computeSchoolStats(schoolId: string) {
    // Aggregate in SQL so only one row crosses the wire. `${schoolId}` is a
    // bound param; `::float` avoids integer division; COUNT(*)::int avoids BigInt.
    const [row] = await this.prisma.$queryRaw<
      Array<{ gradedResults: number; avgPct: number | null }>
    >`
      SELECT COUNT(*)::int AS "gradedResults",
             AVG(er.score::float / e."maxScore") * 100 AS "avgPct"
      FROM "ExamResult" er
      JOIN "Exam" e ON e.id = er."examId"
      WHERE e."schoolId" = ${schoolId}
        AND er.score IS NOT NULL
        AND e."maxScore" > 0
    `;
    const gradedResults = row?.gradedResults ?? 0;
    const averageScorePercent =
      gradedResults === 0 || row?.avgPct == null
        ? null
        : Math.round(row.avgPct * 100) / 100;

    const examCount = await (this.prisma as any).exam.count({
      where: { schoolId },
    });

    return {
      schoolId,
      examCount,
      gradedResults,
      averageScorePercent,
    };
  }

  async get(id: string, actor: Actor, opts?: { studentId?: string }) {
    const exam = await (this.prisma as any).exam.findUnique({
      where: { id },
      include: this.examInclude({ withSection: true }),
    });
    if (!exam) throw new NotFoundException('Exam not found');

    await this.enforceExamAccess(exam, actor, opts);
    return exam;
  }

  async update(id: string, dto: UpdateExamDto, actor: Actor) {
    this.ensureRole(actor, [Role.TEACHER]);

    const exam = await (this.prisma as any).exam.findUnique({
      where: { id },
      include: { sectionSubject: { include: { section: true } } },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    const teacher = await this.getTeacherOrThrow(actor, exam.schoolId);
    if (exam.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException('Only creator teacher can update');
    }

    if (dto.status && !['DRAFT', 'PUBLISHED', 'CLOSED'].includes(dto.status)) {
      throw new BadRequestException('Invalid status');
    }

    const updated = await (this.prisma as any).exam.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && {
          description: dto.description ?? null,
        }),
        ...(dto.heldAt !== undefined && {
          heldAt: dto.heldAt ? new Date(dto.heldAt) : null,
        }),
        ...(dto.maxScore !== undefined && { maxScore: dto.maxScore ?? null }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
      include: this.examInclude(),
    });

    // Notify enrolled students when the exam is newly published.
    if (dto.status === 'PUBLISHED' && exam.status !== 'PUBLISHED') {
      await this.notifyExamPublished(updated);
    }
    return updated;
  }

  /** Fan-out a "new exam scheduled" notification to the section's students. */
  private async notifyExamPublished(a: {
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
      type: 'EXAM_PUBLISHED',
      title: 'New exam scheduled',
      body: `"${a.title}" was scheduled.`,
      link: `/exams/${a.id}`,
      notifyPreferenceKey: 'notifyGrades',
    } as NotificationCreateEvent);
  }

  async publish(id: string, actor: Actor) {
    return this.update(id, { status: 'PUBLISHED' } as any, actor);
  }

  async close(id: string, actor: Actor) {
    return this.update(id, { status: 'CLOSED' } as any, actor);
  }

  async markResult(examId: string, dto: MarkExamResultDto, actor: Actor) {
    this.ensureRole(actor, [Role.TEACHER]);

    const exam = await (this.prisma as any).exam.findUnique({
      where: { id: examId },
      include: { sectionSubject: { include: { section: true } } },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    const teacher = await this.getTeacherOrThrow(actor, exam.schoolId);
    if (exam.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException('Only creator teacher can mark results');
    }

    const enrolled = await this.prisma.enrollment.findFirst({
      where: {
        studentId: dto.studentId,
        sectionId: exam.sectionSubject.sectionId,
        academicYearId: exam.academicYearId,
        status: 'ACTIVE',
      } as any,
    });
    if (!enrolled)
      throw new ForbiddenException('Student not enrolled for this exam');

    const maxScore = exam.maxScore as number | null;
    if (dto.score !== undefined && maxScore !== null && dto.score > maxScore) {
      throw new BadRequestException('score cannot exceed maxScore');
    }

    const result = await (this.prisma as any).examResult.upsert({
      where: {
        examId_studentId: {
          examId,
          studentId: dto.studentId,
        },
      },
      create: {
        examId,
        studentId: dto.studentId,
        score: dto.score ?? null,
        grade: dto.grade ?? null,
        rank: dto.rank ?? null,
        remarks: dto.remarks ?? null,
        markedAt: new Date(),
      },
      update: {
        ...(dto.score !== undefined && { score: dto.score ?? null }),
        ...(dto.grade !== undefined && { grade: dto.grade ?? null }),
        ...(dto.rank !== undefined && { rank: dto.rank ?? null }),
        ...(dto.remarks !== undefined && { remarks: dto.remarks ?? null }),
        markedAt: new Date(),
      },
    });

    // Exam stats (high/low performers, graded count) changed — refresh after commit.
    await invalidateSchoolStats(this.cache, exam.schoolId);

    // Notify the student + their parents that marks were registered/updated.
    const recipients = [
      ...(await studentUserIds(this.prisma, [dto.studentId])),
      ...(await parentUserIds(this.prisma, [dto.studentId])),
    ];
    if (recipients.length) {
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds: recipients,
        type: 'EXAM_RESULT',
        title: `Exam result: ${exam.title}`,
        body: `Marks were registered for "${exam.title}".`,
        link: `/exams/${examId}`,
        notifyPreferenceKey: 'notifyGrades',
      } as NotificationCreateEvent);
    }
    return result;
  }

  async listResults(examId: string, actor: Actor) {
    this.ensureRole(actor, [Role.TEACHER]);

    const exam = await (this.prisma as any).exam.findUnique({
      where: { id: examId },
      include: {
        sectionSubject: {
          include: {
            section: { include: { classGrade: true } },
            subject: true,
          },
        },
        academicYear: true,
      },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    const teacher = await this.getTeacherOrThrow(actor, exam.schoolId);
    if (exam.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException('Only creator teacher can view results');
    }

    // Get all enrolled students for this exam's section
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        sectionId: exam.sectionSubject.sectionId,
        academicYearId: exam.academicYearId,
        status: 'ACTIVE',
      } as any,
      include: {
        student: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get all results for this exam
    const results = await (this.prisma as any).examResult.findMany({
      where: { examId },
      include: {
        student: true,
      },
    });

    // Create a map of results by studentId for quick lookup
    const resultsMap = new Map(results.map((r: any) => [r.studentId, r]));

    // Combine: show all students with their results (or null if not marked)
    const studentsWithResults = enrollments.map((enrollment) => {
      const result = resultsMap.get(enrollment.studentId);
      return {
        student: enrollment.student,
        result: result || null,
      };
    });

    return studentsWithResults;
  }

  async listStudents(examId: string, actor: Actor) {
    this.ensureRole(actor, [Role.TEACHER]);

    const exam = await (this.prisma as any).exam.findUnique({
      where: { id: examId },
      include: {
        sectionSubject: {
          include: {
            section: { include: { classGrade: true } },
            subject: true,
          },
        },
        academicYear: true,
      },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    const teacher = await this.getTeacherOrThrow(actor, exam.schoolId);
    if (exam.createdByTeacherId !== teacher.id) {
      throw new ForbiddenException('Only creator teacher can view students');
    }

    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        sectionId: exam.sectionSubject.sectionId,
        academicYearId: exam.academicYearId,
        status: 'ACTIVE',
      } as any,
      include: {
        student: true,
        section: {
          include: {
            classGrade: true,
          },
        },
        academicYear: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return enrollments;
  }

  async results(examId: string, actor: Actor, query?: { studentId?: string }) {
    const exam = await (this.prisma as any).exam.findUnique({
      where: { id: examId },
      include: { sectionSubject: { include: { section: true } } },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    let targetStudentId: string;

    if (actor.role === Role.STUDENT) {
      const student = await this.getStudentOrThrow(actor);
      targetStudentId = student.id;
    } else if (actor.role === Role.PARENT) {
      const parent = await this.getParentOrThrow(actor);
      if (!query?.studentId)
        throw new BadRequestException('studentId is required');
      await this.ensureChildOfParent(parent.id, query.studentId);
      targetStudentId = query.studentId;
    } else if (actor.role === Role.TEACHER) {
      const teacher = await this.getTeacherOrThrow(actor, exam.schoolId);
      if (exam.createdByTeacherId !== teacher.id) {
        throw new ForbiddenException('Only creator teacher can view results');
      }
      if (!query?.studentId)
        throw new BadRequestException('studentId is required');
      targetStudentId = query.studentId;
    } else {
      throw new ForbiddenException('Not allowed');
    }

    if (
      [Role.STUDENT, Role.PARENT].includes(actor.role) &&
      !['PUBLISHED', 'CLOSED'].includes(exam.status)
    ) {
      throw new ForbiddenException('Exam is not published');
    }

    const enrolled = await this.prisma.enrollment.findFirst({
      where: {
        studentId: targetStudentId,
        sectionId: exam.sectionSubject.sectionId,
        academicYearId: exam.academicYearId,
      } as any,
    });
    if (!enrolled)
      throw new ForbiddenException('Student not enrolled for this exam');

    const result = await (this.prisma as any).examResult.findUnique({
      where: {
        examId_studentId: {
          examId,
          studentId: targetStudentId,
        },
      },
      include: {
        student: true,
      },
    });

    return { examId, studentId: targetStudentId, result: result ?? null };
  }

  private examInclude(opts?: { withSection?: boolean; studentId?: string }) {
    return {
      sectionSubject: {
        include: {
          section: opts?.withSection ? { include: { classGrade: true } } : true,
          subject: true,
          teacher: true,
        },
      },
      academicYear: true,
      createdByTeacher: true,
      // For a STUDENT/PARENT list, fold in that student's own result so the
      // client skips a per-row results call; orderBy makes take:1 deterministic.
      ...(opts?.studentId
        ? {
            results: {
              where: { studentId: opts.studentId },
              orderBy: { markedAt: 'desc' as const },
              take: 1,
              select: {
                id: true,
                score: true,
                grade: true,
                rank: true,
                remarks: true,
              },
            },
          }
        : {}),
    };
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

  private async enforceExamAccess(
    exam: any,
    actor: Actor,
    opts?: { studentId?: string },
  ) {
    if ([Role.SUPER_ADMIN, Role.SCHOOL_ADMIN].includes(actor.role)) {
      if (
        actor.role === Role.SCHOOL_ADMIN &&
        actor.schoolId !== exam.schoolId
      ) {
        throw new ForbiddenException('Cross-school access denied');
      }
      return;
    }

    if (actor.role === Role.TEACHER) {
      const teacher = await this.getTeacherOrThrow(actor, exam.schoolId);
      if (exam.createdByTeacherId !== teacher.id) {
        throw new ForbiddenException('Not allowed');
      }
      return;
    }

    if (actor.role === Role.STUDENT) {
      if (!['PUBLISHED', 'CLOSED'].includes(exam.status)) {
        throw new ForbiddenException('Exam is not published');
      }
      const student = await this.getStudentOrThrow(actor);
      const enrolled = await this.prisma.enrollment.findFirst({
        where: {
          studentId: student.id,
          sectionId: exam.sectionSubject.sectionId,
          academicYearId: exam.academicYearId,
          status: 'ACTIVE',
        } as any,
      });
      if (!enrolled)
        throw new ForbiddenException('Student not enrolled for this exam');
      return;
    }

    if (actor.role === Role.PARENT) {
      if (!['PUBLISHED', 'CLOSED'].includes(exam.status)) {
        throw new ForbiddenException('Exam is not published');
      }
      const parent = await this.getParentOrThrow(actor);
      if (!opts?.studentId)
        throw new BadRequestException('studentId is required');
      await this.ensureChildOfParent(parent.id, opts.studentId);
      const enrolled = await this.prisma.enrollment.findFirst({
        where: {
          studentId: opts.studentId,
          sectionId: exam.sectionSubject.sectionId,
          academicYearId: exam.academicYearId,
          status: 'ACTIVE',
        } as any,
      });
      if (!enrolled)
        throw new ForbiddenException('Student not enrolled for this exam');
      return;
    }

    throw new ForbiddenException('Not allowed');
  }
}
