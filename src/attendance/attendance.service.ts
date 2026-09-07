import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/services/cache.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import {
  SchoolAttendanceStatsQueryDto,
  SectionSubjectAttendanceQueryDto,
  SectionSubjectSummaryQueryDto,
  StudentAttendanceQueryDto,
  StudentAttendanceStatsQueryDto,
  TeacherAttendanceStatsQueryDto,
} from './dto/find-attendance-query.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NOTIFICATION_CREATE,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import {
  parentUserIds,
  studentUserIds,
} from '../common/notifications/recipients';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

@Injectable()
export class AttendanceService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    cache: CacheService,
  ) {
    super(prisma, cache);
  }

  // ---- helpers -----------------------------------------------------------

  private async loadSectionSubject(sectionSubjectId: string) {
    const ss = await this.prisma.sectionSubject.findUnique({
      where: { id: sectionSubjectId },
      include: {
        section: { select: { id: true, schoolId: true } },
        subject: { select: { id: true, name: true } },
      },
    });
    if (!ss) throw new NotFoundException('Subject-class not found');
    return ss;
  }

  private async teacherProfileIdFor(actor: Actor): Promise<string | null> {
    if (!actor.userId) return null;
    const tp = await this.prisma.teacherProfile.findUnique({
      where: { userId: actor.userId },
      select: { id: true },
    });
    return tp?.id ?? null;
  }

  /**
   * A TEACHER may only touch a subject-class they teach (its
   * SectionSubject.teacherId). Admins/super-admins are allowed within scope.
   */
  private async assertSubjectAccess(
    actor: Actor,
    sectionSubject: { teacherId: string | null; section: { schoolId: string } },
  ) {
    this.enforceScope(actor, sectionSubject.section.schoolId);
    if (actor.role === Role.TEACHER) {
      const myTeacherId = await this.teacherProfileIdFor(actor);
      if (
        !sectionSubject.teacherId ||
        !myTeacherId ||
        sectionSubject.teacherId !== myTeacherId
      ) {
        throw new ForbiddenException('You do not teach this subject-class');
      }
    }
  }

  /** Object-level access to a specific student's attendance. */
  private async assertStudentAccess(
    actor: Actor,
    student: { id: string; userId: string | null; schoolId: string },
  ) {
    this.enforceScope(actor, student.schoolId);

    if (actor.role === Role.STUDENT) {
      if (!actor.userId || student.userId !== actor.userId) {
        throw new ForbiddenException('You can only view your own attendance');
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
          "You can only view your linked children's attendance",
        );
      }
      return;
    }

    // TEACHER / SCHOOL_ADMIN / SUPER_ADMIN: same-school (already enforced).
  }

  private toDateOnly(value: string): Date {
    // 'YYYY-MM-DD' -> midnight UTC; matches the @db.Date column.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return d;
  }

  // ---- endpoints ---------------------------------------------------------

  /** Bulk upsert attendance for one subject-period on a date. */
  async mark(dto: MarkAttendanceDto, actor: Actor) {
    const sectionSubject = await this.loadSectionSubject(dto.sectionSubjectId);
    await this.assertSubjectAccess(actor, sectionSubject);

    const schoolId = sectionSubject.section.schoolId;
    const period = dto.period ?? 1;
    const date = this.toDateOnly(dto.date);

    // Only students enrolled in this section may be marked for its subjects.
    const enrolled = await this.prisma.enrollment.findMany({
      where: { sectionId: sectionSubject.section.id, status: 'ACTIVE' },
      select: { studentId: true },
    });
    const enrolledIds = new Set(enrolled.map((e) => e.studentId));

    const unknown = dto.entries.filter((e) => !enrolledIds.has(e.studentId));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Not enrolled in this section: ${unknown
          .map((e) => e.studentId)
          .join(', ')}`,
      );
    }

    // Whole batch is atomic — no half-marked class (CLAUDE.md standing rule).
    const results = await this.prisma.$transaction(
      dto.entries.map((entry) =>
        this.prisma.attendance.upsert({
          where: {
            studentId_sectionSubjectId_date_period: {
              studentId: entry.studentId,
              sectionSubjectId: dto.sectionSubjectId,
              date,
              period,
            },
          },
          update: {
            status: entry.status as any,
            remarks: entry.remarks ?? null,
            markedByUserId: actor.userId,
          },
          create: {
            schoolId,
            studentId: entry.studentId,
            sectionSubjectId: dto.sectionSubjectId,
            period,
            date,
            status: entry.status as any,
            remarks: entry.remarks ?? null,
            markedByUserId: actor.userId,
          },
        }),
      ),
    );

    // Attendance-rate / at-risk tiles just changed — refresh after the commit.
    await this.invalidateSchoolStats(schoolId);

    // Notify each marked student + their parents (grouped per status → ≤4 events).
    await this.notifyAttendanceMarked(dto, sectionSubject);

    return { count: results.length, date: dto.date, period, records: results };
  }

  /** Fan-out attendance-marked notifications to students + parents, per status. */
  private async notifyAttendanceMarked(
    dto: MarkAttendanceDto,
    sectionSubject: { subject: { name: string } },
  ) {
    const subject = sectionSubject.subject?.name ?? 'class';
    const byStatus = new Map<string, string[]>();
    for (const e of dto.entries) {
      const arr = byStatus.get(e.status) ?? [];
      arr.push(e.studentId);
      byStatus.set(e.status, arr);
    }
    for (const [status, studentIds] of byStatus) {
      const userIds = [
        ...(await studentUserIds(this.prisma, studentIds)),
        ...(await parentUserIds(this.prisma, studentIds)),
      ];
      if (!userIds.length) continue;
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds,
        type: 'ATTENDANCE_MARKED',
        title: 'Attendance updated',
        body: `Marked ${status.toLowerCase()} in ${subject} on ${dto.date}.`,
        link: `/attendance`,
        notifyPreferenceKey: 'notifyAttendance',
      } as NotificationCreateEvent);
    }
  }

  /** Roster + status for one subject-period on a date (pre-populates marking UI). */
  async getSectionSubjectAttendance(
    sectionSubjectId: string,
    query: SectionSubjectAttendanceQueryDto,
    actor: Actor,
  ) {
    const sectionSubject = await this.loadSectionSubject(sectionSubjectId);
    await this.assertSubjectAccess(actor, sectionSubject);

    const period = query.period ?? 1;
    const date = this.toDateOnly(query.date);

    const enrollments = await this.prisma.enrollment.findMany({
      where: { sectionId: sectionSubject.section.id, status: 'ACTIVE' },
      include: {
        student: { select: { id: true, fullName: true, rollNo: true } },
      },
      orderBy: { student: { fullName: 'asc' } },
    });

    const marks = await this.prisma.attendance.findMany({
      where: { sectionSubjectId, date, period },
    });
    const byStudent = new Map(marks.map((m) => [m.studentId, m]));

    return {
      sectionSubjectId,
      subject: sectionSubject.subject,
      date: query.date,
      period,
      roster: enrollments.map((e) => {
        const mark = byStudent.get(e.studentId);
        return {
          student: e.student,
          status: mark?.status ?? null,
          remarks: mark?.remarks ?? null,
        };
      }),
    };
  }

  /** A student's per-period history in a date range, paginated. */
  async getStudentAttendance(
    studentId: string,
    query: StudentAttendanceQueryDto,
    actor: Actor,
  ) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { id: true, userId: true, schoolId: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    await this.assertStudentAccess(actor, student);

    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = Math.min(
      query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: any = { studentId };
    if (query.from || query.to) {
      where.date = {};
      if (query.from) where.date.gte = this.toDateOnly(query.from);
      if (query.to) where.date.lte = this.toDateOnly(query.to);
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.attendance.count({ where }),
      this.prisma.attendance.findMany({
        where,
        include: {
          sectionSubject: {
            select: { id: true, subject: { select: { id: true, name: true } } },
          },
        },
        orderBy: [{ date: 'desc' }, { period: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      items: rows.map((r) => ({
        id: r.id,
        date: r.date,
        period: r.period,
        status: r.status,
        remarks: r.remarks,
        subject: r.sectionSubject.subject,
      })),
    };
  }

  /** Attendance-rate aggregates (period-based, plus a daily rollup). */
  async getStudentStats(
    studentId: string,
    query: StudentAttendanceStatsQueryDto,
    actor: Actor,
  ) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { id: true, userId: true, schoolId: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    await this.assertStudentAccess(actor, student);

    const from = query.from ?? null;
    const to = query.to ?? null;
    const compute = () => this.computeStudentStats(studentId, from, to);
    // 60s TTL, no write-invalidation — consistent with computeSchoolSummary
    // (stats tolerate <60s staleness). Key includes the window.
    return this.cache
      ? this.cache.wrap(
          `attendance:student-stats:${studentId}:${from ?? ''}:${to ?? ''}`,
          60,
          compute,
        )
      : compute();
  }

  /**
   * Computed with SQL groupBy so only status×date and status×subject buckets
   * cross the wire. periodBased/bySubject use present-only rate; daily uses any-period-absent.
   */
  private async computeStudentStats(
    studentId: string,
    from: string | null,
    to: string | null,
  ) {
    const where: any = { studentId };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = this.toDateOnly(from);
      if (to) where.date.lte = this.toDateOnly(to);
    }

    const [byDateStatus, bySubjectStatus] = await Promise.all([
      this.prisma.attendance.groupBy({
        by: ['date', 'status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['sectionSubjectId', 'status'],
        where,
        _count: { _all: true },
      }),
    ]);

    // periodBased — totals summed across dates; present-only rate (present/total).
    let present = 0;
    let absent = 0;
    let late = 0;
    let excused = 0;
    for (const g of byDateStatus) {
      const c = g._count._all;
      if (g.status === 'PRESENT') present += c;
      else if (g.status === 'ABSENT') absent += c;
      else if (g.status === 'LATE') late += c;
      else if (g.status === 'EXCUSED') excused += c;
    }
    const periodTotal = present + absent + late + excused;
    const periodBased = {
      total: periodTotal,
      present,
      absent,
      late,
      excused,
      presentRate: periodTotal === 0 ? 0 : round(present / periodTotal),
    };

    // daily — a day is "absent" if ANY period that day was ABSENT.
    const dayHasAbsence = new Map<string, boolean>();
    for (const g of byDateStatus) {
      const key = g.date.toISOString().slice(0, 10);
      const had = dayHasAbsence.get(key) ?? false;
      dayHasAbsence.set(key, had || g.status === 'ABSENT');
    }
    const totalDays = dayHasAbsence.size;
    const presentDays = [...dayHasAbsence.values()].filter((a) => !a).length;

    // bySubject — map sectionSubjectId → subject, aggregate by subject.
    const ssIds = [...new Set(bySubjectStatus.map((g) => g.sectionSubjectId))];
    const sectionSubjects = ssIds.length
      ? await this.prisma.sectionSubject.findMany({
          where: { id: { in: ssIds } },
          select: { id: true, subject: { select: { id: true, name: true } } },
        })
      : [];
    const subjectByss = new Map(
      sectionSubjects.map((ss) => [ss.id, ss.subject]),
    );
    const bySubjectMap = new Map<
      string,
      {
        subjectId: string;
        subjectName: string;
        total: number;
        present: number;
        absent: number;
        late: number;
        excused: number;
      }
    >();
    for (const g of bySubjectStatus) {
      const subj = subjectByss.get(g.sectionSubjectId);
      if (!subj) continue;
      let agg = bySubjectMap.get(subj.id);
      if (!agg) {
        agg = {
          subjectId: subj.id,
          subjectName: subj.name,
          total: 0,
          present: 0,
          absent: 0,
          late: 0,
          excused: 0,
        };
        bySubjectMap.set(subj.id, agg);
      }
      const c = g._count._all;
      agg.total += c;
      if (g.status === 'PRESENT') agg.present += c;
      else if (g.status === 'ABSENT') agg.absent += c;
      else if (g.status === 'LATE') agg.late += c;
      else if (g.status === 'EXCUSED') agg.excused += c;
    }
    const bySubject = [...bySubjectMap.values()]
      .map((s) => ({
        ...s,
        presentRate: s.total === 0 ? 0 : round(s.present / s.total),
      }))
      .sort((a, b) => a.subjectName.localeCompare(b.subjectName));

    return {
      periodBased,
      daily: {
        totalDays,
        presentDays,
        absentDays: totalDays - presentDays,
        presentRate: totalDays === 0 ? 0 : round(presentDays / totalDays),
      },
      bySubject,
    };
  }

  /**
   * Roster-wide attendance summary for one subject-class over an optional date
   * range. Powers the teacher "class summary" view without N per-student calls.
   */
  async getSectionSubjectSummary(
    sectionSubjectId: string,
    query: SectionSubjectSummaryQueryDto,
    actor: Actor,
  ) {
    const sectionSubject = await this.loadSectionSubject(sectionSubjectId);
    await this.assertSubjectAccess(actor, sectionSubject);

    const enrollments = await this.prisma.enrollment.findMany({
      where: { sectionId: sectionSubject.section.id, status: 'ACTIVE' },
      include: {
        student: { select: { id: true, fullName: true, rollNo: true } },
      },
      orderBy: { student: { fullName: 'asc' } },
    });

    const where: any = { sectionSubjectId };
    if (query.from || query.to) {
      where.date = {};
      if (query.from) where.date.gte = this.toDateOnly(query.from);
      if (query.to) where.date.lte = this.toDateOnly(query.to);
    }

    const marks = await this.prisma.attendance.findMany({
      where,
      select: { studentId: true, status: true },
    });

    // Tally per student in a single pass.
    const tally = new Map<
      string,
      { present: number; absent: number; late: number; excused: number }
    >();
    for (const m of marks) {
      const t = tally.get(m.studentId) ?? {
        present: 0,
        absent: 0,
        late: 0,
        excused: 0,
      };
      if (m.status === 'PRESENT') t.present++;
      else if (m.status === 'ABSENT') t.absent++;
      else if (m.status === 'LATE') t.late++;
      else if (m.status === 'EXCUSED') t.excused++;
      tally.set(m.studentId, t);
    }

    return {
      sectionSubjectId,
      subject: sectionSubject.subject,
      from: query.from ?? null,
      to: query.to ?? null,
      students: enrollments.map((e) => {
        const t = tally.get(e.studentId) ?? {
          present: 0,
          absent: 0,
          late: 0,
          excused: 0,
        };
        const total = t.present + t.absent + t.late + t.excused;
        return {
          student: e.student,
          present: t.present,
          absent: t.absent,
          late: t.late,
          excused: t.excused,
          total,
          // "Present" credits both PRESENT and LATE (student attended).
          presentRate: total === 0 ? 0 : round((t.present + t.late) / total),
        };
      }),
    };
  }

  /**
   * Schoolwide attendance rate over a range (default trailing 30 days) plus a
   * "today" slice. Present-rate credits PRESENT and LATE.
   */
  async getSchoolStats(actor: Actor, query: SchoolAttendanceStatsQueryDto) {
    const schoolId = this.resolveSchoolId(actor, query.schoolId);

    const today = startOfUtcDay(new Date());
    const rangeStart = query.from
      ? this.toDateOnly(query.from)
      : new Date(today.getTime() - 29 * DAY_MS);
    const rangeEnd = query.to ? this.toDateOnly(query.to) : today;

    // ponytail: 60s TTL, no write-invalidation — stats tolerate <60s staleness.
    // Key includes the resolved window so different from/to don't collide.
    const from = rangeStart.toISOString().slice(0, 10);
    const to = rangeEnd.toISOString().slice(0, 10);
    const compute = () =>
      this.computeSchoolSummary(schoolId, rangeStart, rangeEnd, today);
    return this.cache
      ? this.cache.wrap(
          `attendance:school-summary:${schoolId}:${from}:${to}`,
          60,
          compute,
        )
      : compute();
  }

  private async computeSchoolSummary(
    schoolId: string,
    rangeStart: Date,
    rangeEnd: Date,
    today: Date,
  ) {
    // Aggregate per (date, status) in SQL — only days×statuses rows cross the
    // wire. Uses the [schoolId, date] index for the range scan.
    const grouped = await this.prisma.attendance.groupBy({
      by: ['date', 'status'],
      where: { schoolId, date: { gte: rangeStart, lte: rangeEnd } },
      _count: { _all: true },
    });
    const todayGrouped = grouped.filter(
      (g) => g.date.getTime() === today.getTime(),
    );

    // Per-day series for the dashboard's 7-day chart. `grouped` is already
    // keyed by (date, status), so this is a regroup — no extra query. Days with
    // no register are emitted with total 0 so the week never has a gap.
    const byDate = new Map<number, typeof grouped>();
    for (const g of grouped) {
      const key = g.date.getTime();
      const list = byDate.get(key) ?? [];
      list.push(g);
      byDate.set(key, list);
    }
    const daily: Array<{
      date: string;
      total: number;
      present: number;
      presentRate: number;
    }> = [];
    // Every day of the requested window, capped at 31 points so a long range
    // can't push a hundred marks into a dashboard-sized chart.
    const spanDays =
      Math.round((rangeEnd.getTime() - rangeStart.getTime()) / DAY_MS) + 1;
    const points = Math.min(Math.max(spanDays, 1), 31);
    for (let i = points - 1; i >= 0; i--) {
      const day = new Date(rangeEnd.getTime() - i * DAY_MS);
      const t = tallyGrouped(byDate.get(day.getTime()) ?? []);
      daily.push({
        date: day.toISOString().slice(0, 10),
        total: t.total,
        present: t.present,
        presentRate: t.presentRate,
      });
    }

    return {
      schoolId,
      from: rangeStart.toISOString().slice(0, 10),
      to: rangeEnd.toISOString().slice(0, 10),
      range: tallyGrouped(grouped),
      today: tallyGrouped(todayGrouped),
      daily,
    };
  }

  /**
   * A teacher's attendance rate per subject-class they teach, over an optional
   * range, in one call (avoids N per-class summary requests on the dashboard).
   */
  async getTeacherStats(actor: Actor, query: TeacherAttendanceStatsQueryDto) {
    if (actor.role !== Role.TEACHER) {
      throw new ForbiddenException('Teachers only');
    }
    const teacherId = await this.teacherProfileIdFor(actor);
    if (!teacherId)
      return { from: null, to: null, sections: [], overall: tally([]) };

    const from = query.from ?? null;
    const to = query.to ?? null;
    const compute = () => this.computeTeacherStats(teacherId, from, to);
    return this.cache
      ? this.cache.wrap(
          `attendance:teacher-stats:${teacherId}:${from ?? ''}:${to ?? ''}`,
          60,
          compute,
        )
      : compute();
  }

  private async computeTeacherStats(
    teacherId: string,
    from: string | null,
    to: string | null,
  ) {
    const sectionSubjects = await this.prisma.sectionSubject.findMany({
      where: { teacherId },
      select: {
        id: true,
        subject: { select: { id: true, name: true } },
        section: {
          select: {
            id: true,
            name: true,
            classGrade: { select: { name: true } },
          },
        },
      },
    });
    if (sectionSubjects.length === 0) {
      return { from, to, sections: [], overall: tally([]) };
    }

    const where: any = {
      sectionSubjectId: { in: sectionSubjects.map((s) => s.id) },
    };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = this.toDateOnly(from);
      if (to) where.date.lte = this.toDateOnly(to);
    }

    // Aggregate per (sectionSubject, status) in SQL — bounded output, uses the
    // [sectionSubjectId, date] index (was: every attendance row streamed to Node).
    const grouped = await this.prisma.attendance.groupBy({
      by: ['sectionSubjectId', 'status'],
      where,
      _count: { _all: true },
    });

    const byId = new Map<
      string,
      { status: string; _count: { _all: number } }[]
    >();
    for (const g of grouped) {
      const arr = byId.get(g.sectionSubjectId) ?? [];
      arr.push(g);
      byId.set(g.sectionSubjectId, arr);
    }

    return {
      from,
      to,
      sections: sectionSubjects.map((ss) => ({
        sectionSubjectId: ss.id,
        subject: ss.subject,
        section: ss.section,
        ...tallyGrouped(byId.get(ss.id) ?? []),
      })),
      overall: tallyGrouped(grouped),
    };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** Present/absent/late/excused counts + present rate (PRESENT+LATE = attended). */
function tally(rows: { status: string }[]) {
  const present = rows.filter((r) => r.status === 'PRESENT').length;
  const absent = rows.filter((r) => r.status === 'ABSENT').length;
  const late = rows.filter((r) => r.status === 'LATE').length;
  const excused = rows.filter((r) => r.status === 'EXCUSED').length;
  const total = rows.length;
  return {
    total,
    present,
    absent,
    late,
    excused,
    presentRate: total === 0 ? 0 : round((present + late) / total),
  };
}

// Same shape as tally(), but from a groupBy(['status']) result so the counting
// happens in SQL instead of streaming every row to Node.
function tallyGrouped(rows: { status: string; _count: { _all: number } }[]) {
  let present = 0;
  let absent = 0;
  let late = 0;
  let excused = 0;
  let total = 0;
  for (const g of rows) {
    const c = g._count._all;
    total += c;
    if (g.status === 'PRESENT') present += c;
    else if (g.status === 'ABSENT') absent += c;
    else if (g.status === 'LATE') late += c;
    else if (g.status === 'EXCUSED') excused += c;
  }
  return {
    total,
    present,
    absent,
    late,
    excused,
    presentRate: total === 0 ? 0 : round((present + late) / total),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
