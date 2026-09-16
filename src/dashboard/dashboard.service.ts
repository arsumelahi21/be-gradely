import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { CacheService } from '../common/services/cache.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { ExamsService } from '../exams/exams.service';
import { ExamSettingsService } from '../exams/exam-settings.service';
import { gradeForMarks, passMarkPercent } from '../exams/result-calculator';
import { AssignmentsService } from '../assignments/assignments.service';
import { AttendanceService } from '../attendance/attendance.service';

// A student is "at risk" below this schoolwide attendance rate (PRESENT+LATE).
const AT_RISK_RATE = 0.75;

@Injectable()
export class DashboardService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly exams: ExamsService,
    private readonly settings: ExamSettingsService,
    private readonly assignments: AssignmentsService,
    private readonly attendance: AttendanceService,
  ) {
    super(prisma, cache);
  }

  /**
   * Everything the school-admin dashboard needs in ONE request: count tiles,
   * recent-activity feed, and the four whole-school stat blocks, assembled in parallel.
   */
  async getSchoolOverview(actor: Actor, opts?: { schoolId?: string }) {
    // resolveSchoolId enforces tenant access BEFORE the cache lookup, so a hit
    // can't leak across schools. TTL is a backstop; writes call invalidateSchoolStats().
    const schoolId = this.resolveSchoolId(actor, opts?.schoolId);
    const compute = () => this.computeSchoolOverview(actor, schoolId, opts);
    return this.cache
      ? this.cache.wrap(`dashboard:overview:${schoolId}`, 60, compute)
      : compute();
  }

  private async computeSchoolOverview(
    actor: Actor,
    schoolId: string,
    opts?: { schoolId?: string },
  ) {
    // 5 most-recent of EACH role (3 queries so one role can't starve another's
    // signups). Whole envelope is cached; runs only on a cold recompute.
    const recentUsers = (role: Role) =>
      this.prisma.user.findMany({
        where: { schoolId, role },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, fullName: true, email: true, createdAt: true },
      });
    // Start of the current calendar month, for the "+N this month" deltas the
    // dashboard tiles show. Same clock as `createdAt`, so no timezone maths.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [
      roleCounts,
      classesCount,
      newRoleCounts,
      newClassesCount,
      teachers,
      students,
      parents,
      recentClasses,
      attendance,
      exams,
      assignments,
      stats,
    ] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['role'],
        where: { schoolId },
        _count: { _all: true },
      }),
      this.prisma.classGrade.count({ where: { schoolId } }),
      this.prisma.user.groupBy({
        by: ['role'],
        where: { schoolId, createdAt: { gte: monthStart } },
        _count: { _all: true },
      }),
      this.prisma.classGrade.count({
        where: { schoolId, createdAt: { gte: monthStart } },
      }),
      recentUsers(Role.TEACHER),
      recentUsers(Role.STUDENT),
      recentUsers(Role.PARENT),
      this.prisma.classGrade.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, name: true, createdAt: true },
      }),
      this.attendance.getSchoolStats(actor, { schoolId }),
      this.exams.getSchoolStats(actor, opts),
      this.assignments.getSchoolStats(actor, opts),
      this.getSchoolStats(actor, opts),
    ]);
    const countFor = (role: Role) =>
      roleCounts.find((r) => r.role === role)?._count._all ?? 0;
    const newCountFor = (role: Role) =>
      newRoleCounts.find((r) => r.role === role)?._count._all ?? 0;
    return {
      counts: {
        teachers: countFor(Role.TEACHER),
        students: countFor(Role.STUDENT),
        parents: countFor(Role.PARENT),
        classes: classesCount,
      },
      // Added since the 1st of this month — a REAL delta, so the tiles never
      // have to invent one. Zero is a legitimate answer and renders as "+0".
      addedThisMonth: {
        teachers: newCountFor(Role.TEACHER),
        students: newCountFor(Role.STUDENT),
        parents: newCountFor(Role.PARENT),
        classes: newClassesCount,
      },
      recent: { teachers, students, parents, classes: recentClasses },
      attendance,
      exams,
      assignments,
      stats,
    };
  }

  /**
   * Everything the super-admin dashboard needs in ONE request: all schools +
   * the two cross-school role counts folded into a single `groupBy`.
   */
  async getAdminOverview(actor: Actor) {
    if (actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Super admin only');
    }
    // Cross-school (not per-tenant): schools list + role counts. Cached with a
    // 60s TTL; schools/user writes clear `dashboard:admin-overview` to refresh.
    const compute = async () => {
      const [schools, roleCounts] = await Promise.all([
        this.prisma.school.findMany({ orderBy: { createdAt: 'desc' } }),
        this.prisma.user.groupBy({
          by: ['role'],
          where: { role: { in: [Role.SCHOOL_ADMIN, Role.STUDENT] } },
          _count: { _all: true },
        }),
      ]);
      const countFor = (role: Role) =>
        roleCounts.find((r) => r.role === role)?._count._all ?? 0;
      return {
        schools,
        counts: {
          schoolAdmins: countFor(Role.SCHOOL_ADMIN),
          students: countFor(Role.STUDENT),
        },
      };
    };
    return this.cache
      ? this.cache.wrap('dashboard:admin-overview', 60, compute)
      : compute();
  }

  /**
   * School-admin dashboard metrics in one tenant-scoped call: gender split,
   * high/low performers, at-risk attendance, new admissions, average class size.
   */
  async getSchoolStats(actor: Actor, opts?: { schoolId?: string }) {
    const schoolId = this.resolveSchoolId(actor, opts?.schoolId);
    // ponytail: 60s TTL, no write-invalidation — stats tolerate <60s staleness.
    // Add delByPrefix on writes if sub-60s freshness is ever required.
    const compute = () => this.computeSchoolStats(schoolId);
    return this.cache
      ? this.cache.wrap(`dashboard:stats:${schoolId}`, 60, compute)
      : compute();
  }

  private async computeSchoolStats(schoolId: string) {
    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

    const [
      genderGroups,
      totalStudents,
      newAdmissions,
      examByStudent,
      attendanceGroups,
      activeEnrollments,
      sectionCount,
      bands,
    ] = await Promise.all([
      this.prisma.studentProfile.groupBy({
        by: ['gender'],
        where: { schoolId, isActive: true },
        _count: true,
      }),
      this.prisma.studentProfile.count({ where: { schoolId, isActive: true } }),
      this.prisma.studentProfile.count({
        where: { schoolId, isActive: true, dateOfJoining: { gte: yearStart } },
      }),
      // Marks summed per student with absence as 0 — how the result engine totals them, not a
      // mean of paper percentages. Finalized only, so provisional marks can't flag anyone.
      this.prisma.$queryRaw<
        Array<{ studentId: string; obtained: number; total: number }>
      >`
        SELECT er."studentId" AS "studentId",
               SUM(CASE WHEN er."isAbsent" THEN 0 ELSE er.score END)::int AS obtained,
               SUM(e."maxScore")::int AS total
        FROM "ExamResult" er
        JOIN "Exam" e ON e.id = er."examId"
        JOIN "Examination" x ON x.id = e."examinationId"
        WHERE e."schoolId" = ${schoolId}
          AND x."resultStatus" = 'FINALIZED'
          AND (er.score IS NOT NULL OR er."isAbsent")
          AND e."maxScore" > 0
        GROUP BY er."studentId"
      `,
      // Per-student status tallies (was: every Attendance row streamed to Node).
      this.prisma.attendance.groupBy({
        by: ['studentId', 'status'],
        where: { schoolId },
        _count: { _all: true },
      }),
      this.prisma.enrollment.count({
        where: { status: 'ACTIVE', section: { schoolId } },
      }),
      this.prisma.section.count({ where: { schoolId, isActive: true } }),
      this.settings.bandsFor(this.prisma, schoolId, null),
    ]);

    const gender = { male: 0, female: 0, other: 0, unspecified: 0 };
    for (const g of genderGroups) {
      const c = g._count;
      if (g.gender === 'MALE') gender.male += c;
      else if (g.gender === 'FEMALE') gender.female += c;
      else if (g.gender === 'OTHER') gender.other += c;
      else gender.unspecified += c; // PREFER_NOT_TO_SAY or null
    }

    // Performers by the school's own default scheme on exact marks: top band = high achiever,
    // a failing band = low performer. No thresholds are hard-coded here.
    const topBand = [...bands].sort((a, b) => b.minPercent - a.minPercent)[0];
    let highAchievers = 0;
    let lowPerformers = 0;
    for (const { obtained, total } of examByStudent) {
      const band = gradeForMarks(obtained, total, bands);
      if (!band) continue;
      if (band === topBand) highAchievers += 1;
      else if (!band.isPassing) lowPerformers += 1;
    }
    const gradedStudents = examByStudent.length;

    const byAttendance = new Map<string, { attended: number; total: number }>();
    for (const g of attendanceGroups) {
      const agg = byAttendance.get(g.studentId) ?? { attended: 0, total: 0 };
      const c = g._count._all;
      agg.total += c;
      if (g.status === 'PRESENT' || g.status === 'LATE') agg.attended += c;
      byAttendance.set(g.studentId, agg);
    }
    let atRiskAttendance = 0;
    for (const { attended, total } of byAttendance.values()) {
      if (total > 0 && attended / total < AT_RISK_RATE) atRiskAttendance += 1;
    }

    const avgClassSize =
      sectionCount === 0 ? 0 : Math.round(activeEnrollments / sectionCount);

    return {
      schoolId,
      totalStudents,
      gender,
      highAchievers,
      lowPerformers,
      gradedStudents,
      passPercent: passMarkPercent(bands),
      atRiskAttendance,
      newAdmissions,
      avgClassSize,
    };
  }
}
