import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { AuditLogService } from '../../audit/audit.service';
import { resolvePagination } from '../../common/dto/pagination-query.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { subjectsOf } from '../section-subjects/subject-takers';
import {
  NOTIFICATION_CREATE_BATCH,
  NotificationCreateBatchEvent,
} from '../../common/events/notification.events';
import {
  parentUserIdsByStudent,
  studentUserIdByStudent,
} from '../../common/notifications/recipients';
import { FindStudentSubjectsQueryDto } from './dto/find-student-subjects-query.dto';
import { UpdateStudentSubjectsDto } from './dto/update-student-subjects.dto';

/** students × subjects, kept well inside Prisma's 5s interactive-transaction budget. */
const MAX_ROWS_PER_REQUEST = 5000;

export interface SkippedStudent {
  studentId: string;
  studentName: string | null;
  reason: string;
}

@Injectable()
export class StudentSubjectsService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, cache);
  }

  /** Binds every lookup to the caller's school, so another school's id 404s instead of 403ing. */
  private schoolFilter(actor: Actor) {
    return actor.role === Role.SUPER_ADMIN ? {} : { schoolId: actor.schoolId! };
  }

  // ---- reads -------------------------------------------------------------

  async matrix(query: FindStudentSubjectsQueryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const section = await this.prisma.section.findFirst({
      where: { id: query.sectionId, ...this.schoolFilter(actor) },
      select: {
        id: true,
        name: true,
        schoolId: true,
        classGrade: { select: { id: true, name: true } },
      },
    });
    if (!section) throw new NotFoundException('Section not found');

    // Bound to the section's school, which is also the same-school assertion a
    // SUPER_ADMIN needs — enforceScope waves them through.
    const year = await this.prisma.academicYear.findFirst({
      where: { id: query.academicYearId, schoolId: section.schoolId },
      select: { id: true, name: true },
    });
    if (!year) throw new NotFoundException('Academic session not found');

    const offerings = await this.prisma.sectionSubject.findMany({
      where: { sectionId: section.id },
      select: {
        id: true,
        isElective: true,
        subject: { select: { id: true, name: true, code: true } },
      },
      orderBy: { subject: { name: 'asc' } },
    });
    const electiveIds = offerings.filter((o) => o.isElective).map((o) => o.id);

    const search = query.q?.trim();
    const where: Prisma.EnrollmentWhereInput = {
      sectionId: section.id,
      academicYearId: year.id,
      status: EnrollmentStatus.ACTIVE,
      ...(search && {
        student: {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            { rollNo: { contains: search, mode: 'insensitive' } },
          ],
        },
      }),
    };
    const { page, pageSize, skip, take } = resolvePagination(query);
    const [rows, total, rosterTotal] = await Promise.all([
      this.prisma.enrollment.findMany({
        where,
        skip,
        take,
        orderBy: [
          { student: { rollNo: 'asc' } },
          { student: { fullName: 'asc' } },
        ],
        select: {
          student: { select: { id: true, fullName: true, rollNo: true } },
        },
      }),
      this.prisma.enrollment.count({ where }),
      this.prisma.enrollment.count({
        where: {
          sectionId: section.id,
          academicYearId: year.id,
          status: EnrollmentStatus.ACTIVE,
        },
      }),
    ]);

    const students = rows.map((r) => r.student);
    const selectedBy = await this.selectionsFor(
      electiveIds,
      students.map((s) => s.id),
      year.id,
    );

    return {
      section: {
        id: section.id,
        name: section.name,
        classGrade: section.classGrade,
      },
      academicYear: year,
      offerings: offerings.map((o) => ({
        sectionSubjectId: o.id,
        isElective: o.isElective,
        subject: o.subject,
      })),
      items: students.map((student) => ({
        student,
        selected: selectedBy.get(student.id) ?? [],
      })),
      total,
      page,
      pageSize,
      rosterTotal,
    };
  }

  /** One student's combination — the read the student and parent portals use. */
  async forStudent(studentId: string, actor: Actor) {
    // Bound to the caller's school so another school's student 404s: fetching by
    // id and then throwing 403 would confirm that id exists.
    const student = await this.prisma.studentProfile.findFirst({
      where: { id: studentId, ...this.schoolFilter(actor) },
      select: {
        id: true,
        userId: true,
        schoolId: true,
        fullName: true,
        rollNo: true,
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    await this.assertStudentAccess(actor, student);

    const placement = await this.prisma.enrollment.findFirst({
      where: { studentId, status: EnrollmentStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
      select: {
        sectionId: true,
        academicYearId: true,
        section: {
          select: {
            id: true,
            name: true,
            classGrade: { select: { id: true, name: true } },
          },
        },
        academicYear: { select: { id: true, name: true } },
      },
    });
    const header = {
      student: {
        id: student.id,
        fullName: student.fullName,
        rollNo: student.rollNo,
      },
    };
    if (!placement) {
      return { ...header, section: null, academicYear: null, subjects: [] };
    }

    const taken = await subjectsOf(
      this.prisma,
      studentId,
      placement.sectionId,
      placement.academicYearId,
    );
    const rows = taken.size
      ? await this.prisma.sectionSubject.findMany({
          where: { id: { in: [...taken] } },
          select: {
            id: true,
            isElective: true,
            subject: { select: { id: true, name: true, code: true } },
          },
          orderBy: { subject: { name: 'asc' } },
        })
      : [];

    return {
      ...header,
      section: placement.section,
      academicYear: placement.academicYear,
      subjects: rows.map((r) => ({
        sectionSubjectId: r.id,
        isElective: r.isElective,
        subject: r.subject,
      })),
    };
  }

  // ---- write -------------------------------------------------------------

  async update(dto: UpdateStudentSubjectsDto, actor: Actor) {
    this.ensureAdmin(actor);
    const add = [...new Set(dto.add ?? [])];
    const remove = [...new Set(dto.remove ?? [])];
    if (!add.length && !remove.length) {
      throw new BadRequestException(
        'Choose at least one subject to add or remove',
      );
    }
    if (add.some((id) => remove.includes(id))) {
      throw new BadRequestException(
        'A subject cannot be added and removed in the same request',
      );
    }
    const studentIds = [...new Set(dto.studentIds)];
    // The per-array caps still multiply out to 25k rows, which would exceed the
    // transaction timeout as an opaque Prisma error rather than a usable one.
    if (studentIds.length * add.length > MAX_ROWS_PER_REQUEST) {
      throw new BadRequestException(
        `That is ${studentIds.length * add.length} changes at once. Assign fewer subjects, or fewer students at a time.`,
      );
    }

    const { sectionId, schoolId, sectionLabel, nameOf } =
      await this.resolveSubjects([...add, ...remove], actor);
    const year = await this.prisma.academicYear.findFirst({
      where: { id: dto.academicYearId, schoolId },
      select: { id: true, name: true, startDate: true, endDate: true },
    });
    if (!year) throw new NotFoundException('Academic session not found');

    // Placement and dependent-record checks run INSIDE the transaction: a
    // student unenrolled, or a mark entered, between check and write would
    // otherwise slip through.
    const result = await this.prisma.$transaction(async (tx) => {
      const placement = await this.partitionStudents(
        tx,
        studentIds,
        sectionId,
        year.id,
        schoolId,
      );
      const kept =
        remove.length && placement.eligible.length
          ? await this.withRecords(tx, placement.eligible, remove, year, nameOf)
          : [];
      const keptIds = new Set(kept.map((k) => k.studentId));
      const eligible = placement.eligible.filter((id) => !keptIds.has(id));
      const skipped = [...placement.skipped, ...kept];
      const held = eligible.length
        ? await tx.studentSubject.findMany({
            where: {
              studentId: { in: eligible },
              academicYearId: year.id,
              sectionSubjectId: { in: [...add, ...remove] },
            },
            select: { studentId: true, sectionSubjectId: true },
          })
        : [];

      let added = 0;
      let removed = 0;
      if (add.length && eligible.length) {
        const created = await tx.studentSubject.createMany({
          data: eligible.flatMap((studentId) =>
            add.map((sectionSubjectId) => ({
              schoolId,
              academicYearId: year.id,
              studentId,
              sectionSubjectId,
            })),
          ),
          // A subject already chosen is not an error to re-send; the unique key decides.
          skipDuplicates: true,
        });
        added = created.count;
      }
      if (remove.length && eligible.length) {
        const deleted = await tx.studentSubject.deleteMany({
          where: {
            studentId: { in: eligible },
            sectionSubjectId: { in: remove },
            academicYearId: year.id,
          },
        });
        removed = deleted.count;
      }
      return { added, removed, eligible, skipped, held };
    });
    const { eligible, skipped, held, ...counts } = result;

    await this.audit.record(actor.userId, 'STUDENT_SUBJECT_UPDATE', {
      schoolId,
      entityType: 'Section',
      entityId: sectionId,
      metadata: {
        academicYearId: year.id,
        studentsUpdated: eligible.length,
        studentsSkipped: skipped.length,
        add,
        remove,
        ...counts,
      },
    });

    const had = new Set(
      held.map((r) => `${r.studentId}:${r.sectionSubjectId}`),
    );
    await this.notifyChanges(
      eligible.map((studentId) => ({
        studentId,
        added: add.filter((id) => !had.has(`${studentId}:${id}`)),
        removed: remove.filter((id) => had.has(`${studentId}:${id}`)),
      })),
      nameOf,
      `${sectionLabel} (${year.name})`,
      sectionId,
    );

    return {
      ...counts,
      studentsUpdated: eligible.length,
      skipped,
    };
  }

  /** One notification per student and to their guardians, naming what changed. */
  private async notifyChanges(
    changes: { studentId: string; added: string[]; removed: string[] }[],
    nameOf: Map<string, string>,
    where: string,
    sectionId: string,
  ) {
    const changed = changes.filter((c) => c.added.length || c.removed.length);
    if (!changed.length) return;
    const ids = changed.map((c) => c.studentId);
    const [own, parents, profiles] = await Promise.all([
      studentUserIdByStudent(this.prisma, ids),
      parentUserIdsByStudent(this.prisma, ids),
      this.prisma.studentProfile.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true },
      }),
    ]);
    const fullName = new Map(profiles.map((p) => [p.id, p.fullName]));
    const names = (list: string[]) =>
      list.map((id) => nameOf.get(id)).join(', ');

    const items: NotificationCreateBatchEvent['items'] = [];
    for (const c of changed) {
      const body = [
        `${where}.`,
        c.added.length ? `Added: ${names(c.added)}.` : '',
        c.removed.length ? `Removed: ${names(c.removed)}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const common = {
        body,
        link: '/subjects',
        entityType: 'Section',
        entityId: sectionId,
      };
      const self = own.get(c.studentId);
      if (self) {
        items.push({
          ...common,
          userIds: [self],
          title: 'Your subjects were updated',
        });
      }
      const guardians = parents.get(c.studentId) ?? [];
      if (guardians.length) {
        items.push({
          ...common,
          // A guardian of several children lands on this one, not whoever is selected.
          link: `/subjects?studentId=${c.studentId}`,
          userIds: guardians,
          title: `${fullName.get(c.studentId) ?? 'Your child'}'s subjects were updated`,
        });
      }
    }
    if (!items.length) return;
    this.eventEmitter.emit(NOTIFICATION_CREATE_BATCH, {
      type: 'SUBJECTS_UPDATED',
      notifyPreferenceKey: 'notifyAnnouncements',
      items,
    } as NotificationCreateBatchEvent);
  }

  // ---- helpers -----------------------------------------------------------

  private async selectionsFor(
    electiveIds: string[],
    studentIds: string[],
    academicYearId: string,
  ): Promise<Map<string, string[]>> {
    const byStudent = new Map<string, string[]>();
    if (!electiveIds.length || !studentIds.length) return byStudent;
    const rows = await this.prisma.studentSubject.findMany({
      where: {
        sectionSubjectId: { in: electiveIds },
        academicYearId,
        studentId: { in: studentIds },
      },
      select: { studentId: true, sectionSubjectId: true },
    });
    for (const row of rows) {
      byStudent.set(row.studentId, [
        ...(byStudent.get(row.studentId) ?? []),
        row.sectionSubjectId,
      ]);
    }
    return byStudent;
  }

  /**
   * Resolves the subjects being changed and, with them, the section and school
   * the whole request is scoped to — the client never gets to name either.
   */
  private async resolveSubjects(ids: string[], actor: Actor) {
    const offerings = await this.prisma.sectionSubject.findMany({
      where: {
        id: { in: ids },
        ...(actor.role === Role.SUPER_ADMIN
          ? {}
          : { section: { schoolId: actor.schoolId! } }),
      },
      select: {
        id: true,
        isElective: true,
        sectionId: true,
        section: {
          select: {
            schoolId: true,
            name: true,
            classGrade: { select: { name: true } },
          },
        },
        subject: { select: { name: true } },
      },
    });
    if (offerings.length !== ids.length) {
      throw new NotFoundException(
        'One or more of those subjects could not be found',
      );
    }
    const sectionIds = new Set(offerings.map((o) => o.sectionId));
    if (sectionIds.size > 1) {
      throw new BadRequestException(
        'All subjects in one request must belong to the same section',
      );
    }
    const compulsory = offerings.filter((o) => !o.isElective);
    if (compulsory.length) {
      const names = compulsory.map((o) => o.subject.name).join(', ');
      throw new BadRequestException(
        `${names} ${compulsory.length === 1 ? 'is' : 'are'} taken by the whole class and cannot be assigned to individual students. Set it to Student selection first.`,
      );
    }
    const { section } = offerings[0];
    return {
      sectionId: offerings[0].sectionId,
      schoolId: section.schoolId,
      sectionLabel: [section.classGrade?.name.trim(), section.name]
        .filter(Boolean)
        .join(' '),
      nameOf: new Map(offerings.map((o) => [o.id, o.subject.name])),
    };
  }

  /** Splits the requested students into those actually sitting in the section that session, and why the rest aren't. */
  private async partitionStudents(
    db: Prisma.TransactionClient,
    studentIds: string[],
    sectionId: string,
    academicYearId: string,
    schoolId: string,
  ): Promise<{ eligible: string[]; skipped: SkippedStudent[] }> {
    const [known, placed] = await Promise.all([
      db.studentProfile.findMany({
        where: { id: { in: studentIds }, schoolId },
        select: { id: true, fullName: true },
      }),
      db.enrollment.findMany({
        where: {
          studentId: { in: studentIds },
          sectionId,
          academicYearId,
          status: EnrollmentStatus.ACTIVE,
        },
        select: { studentId: true },
      }),
    ]);
    const nameOf = new Map(known.map((s) => [s.id, s.fullName]));
    const active = new Set(placed.map((p) => p.studentId));

    const eligible: string[] = [];
    const skipped: SkippedStudent[] = [];
    for (const studentId of studentIds) {
      if (active.has(studentId)) {
        eligible.push(studentId);
        continue;
      }
      const studentName = nameOf.get(studentId) ?? null;
      skipped.push({
        studentId,
        studentName,
        reason: studentName
          ? `${studentName} is not currently enrolled in this section for this academic session`
          : 'Student not found',
      });
    }
    return { eligible, skipped };
  }

  /**
   * Whether a mid-session change is allowed at all is an open business rule, so a
   * student with marks or attendance this session keeps the subject — skipped, not failing the batch.
   */
  private async withRecords(
    db: Prisma.TransactionClient,
    studentIds: string[],
    sectionSubjectIds: string[],
    year: { id: string; startDate: Date; endDate: Date },
    subjectName: Map<string, string>,
  ): Promise<SkippedStudent[]> {
    const [marked, attended] = await Promise.all([
      db.examResult.findMany({
        where: {
          studentId: { in: studentIds },
          exam: {
            sectionSubjectId: { in: sectionSubjectIds },
            academicYearId: year.id,
          },
        },
        select: {
          studentId: true,
          exam: { select: { sectionSubjectId: true } },
        },
      }),
      // Attendance carries no session and a section keeps its subjects across
      // sessions, so only the session's dates keep last year's rows out.
      db.attendance.groupBy({
        by: ['studentId', 'sectionSubjectId'],
        where: {
          studentId: { in: studentIds },
          sectionSubjectId: { in: sectionSubjectIds },
          date: { gte: year.startDate, lte: year.endDate },
        },
      }),
    ]);
    const recorded = new Map<string, Set<string>>();
    for (const { studentId, sectionSubjectId } of [
      ...marked.map((m) => ({ studentId: m.studentId, ...m.exam })),
      ...attended,
    ]) {
      recorded.set(
        studentId,
        (recorded.get(studentId) ?? new Set()).add(sectionSubjectId),
      );
    }
    if (!recorded.size) return [];

    const names = await db.studentProfile.findMany({
      where: { id: { in: [...recorded.keys()] } },
      select: { id: true, fullName: true },
    });
    const nameOf = new Map(names.map((s) => [s.id, s.fullName]));
    return [...recorded].map(([studentId, ids]) => {
      const studentName = nameOf.get(studentId) ?? null;
      const subjects = [...ids].map((id) => subjectName.get(id)).join(', ');
      return {
        studentId,
        studentName,
        reason: `Marks or attendance are already recorded for ${studentName ?? 'this student'} in ${subjects} this session. Remove those records first, or keep the subject.`,
      };
    });
  }

  private async assertStudentAccess(
    actor: Actor,
    student: { id: string; userId: string | null; schoolId: string },
  ) {
    this.enforceScope(actor, student.schoolId);

    if (actor.role === Role.STUDENT) {
      if (!actor.userId || student.userId !== actor.userId) {
        throw new ForbiddenException('You can only view your own subjects');
      }
      return;
    }

    if (actor.role === Role.PARENT) {
      const link = await this.prisma.parentStudent.findFirst({
        where: {
          studentId: student.id,
          parent: { userId: actor.userId ?? undefined },
        },
        select: { studentId: true },
      });
      if (!link) {
        throw new ForbiddenException(
          "You can only view your linked children's subjects",
        );
      }
    }
  }
}
