import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeeReportsService } from '../fees/fee-reports.service';
import { AttendanceService } from '../attendance/attendance.service';
import { TimetableService } from '../academics/timetable/timetable.service';
import { Role } from '../common/types/role.type';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
  YearRef,
} from './director.service';
import { DirectorQueriesService } from './director.queries';
import { InsightsQueryDto } from './dto/insights-query.dto';
import {
  RangeWindow,
  Ratio,
  daysSince,
  nthWorkingDayBack,
  previousWindow,
  ratio,
  resolveWindow,
} from './insights';

const DAY_MS = 86_400_000;

interface Trend {
  now: Ratio;
  prev: Ratio;
}

/**
 * One row per branch: each area's headline plus the "before" figure it is judged against, so
 * the page can flag a branch while it is slipping, not only once it has failed.
 */
export interface OverviewData {
  currency: string;
  enrolled: number | null;
  /** The last 30 days against the 30 before, whatever the page filter. */
  attendance: Trend;
  /** Finalized results this session against the session before. */
  pass: { now: Ratio; prev: Ratio | null } | null;
  collectionRate: Ratio | null;
  /** This month's bills paid by today, against last month's by the same day. */
  pace: Trend;
  overdue: number | null;
  receiptsWaitingDays: number | null;
  teachingGaps: number | null;
  timetable: {
    published: number;
    sections: number;
    sessionDays: number;
  } | null;
  /** Sections with students that took no register for 3 / 5 working days. */
  registers: { silent3: number; silent5: number; of: number } | null;
  exams: {
    reviewWaitingDays: number | null;
    overdue7: number;
    overdue14: number;
  } | null;
  /** Students below 75% attendance (10+ marks), this 30 days and the 30 before. */
  belowFloor: { now: number; prev: number } | null;
  /** Parents who signed in, this 30 days and the 30 before. */
  parents: Trend;
  teacherLeavers: number;
  principal: { active: number; daysSinceLogin: number | null };
}

export interface OverviewGroup {
  enrolled: number;
  attendance: Trend;
  pass: { now: Ratio; prev: Ratio };
  /**
   * Fee rates in different currencies can't be pooled by amount, so the headline is the plain
   * average of branch rates, each branch counting once (decided 2026-10-02).
   */
  collection: {
    average: number | null;
    branches: number;
    paceNow: number | null;
    pacePrev: number | null;
  };
}

const sumRatio = (rows: Ratio[]) =>
  ratio(
    rows.reduce((s, r) => s + r.num, 0),
    rows.reduce((s, r) => s + r.den, 0),
  );

const mean = (values: (number | null | undefined)[]) => {
  const v = values.filter((x): x is number => x !== null && x !== undefined);
  return v.length
    ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10_000) / 10_000
    : null;
};

/** Overview (12-V2-PLAN §2): a scorecard and early warnings, from the same cached figures as the tabs. */
@Injectable()
export class DirectorOverviewService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
    private prisma: PrismaService,
    private feeReports: FeeReportsService,
    private attendance: AttendanceService,
    private timetable: TimetableService,
  ) {}

  insights(scope: DirectorScope, query: InsightsQueryDto) {
    // The overview has fixed windows; only branch, session and suspended filters apply.
    const fixed = {
      ...query,
      preset: undefined,
      from: undefined,
      to: undefined,
    };
    return this.director.insights<OverviewData, OverviewGroup>(
      scope,
      fixed,
      (ctx) => this.branchOverview(ctx),
      (rows) => this.rollUp(rows),
    );
  }

  private async branchOverview(ctx: BranchContext): Promise<OverviewData> {
    const { branch, year, priorYear, currentYear, now } = ctx;
    const last30 = resolveWindow({}, now);
    const before30 = previousWindow(last30);
    const [
      attendanceNow,
      attendanceBefore,
      pace,
      parents,
      leavers,
      principal,
      receipts,
    ] = await Promise.all([
      this.attendanceRate(ctx, last30),
      this.attendanceRate(ctx, before30),
      this.pace(branch.id, now),
      this.parentSignIns(branch.id, last30, before30),
      this.queries.teacherLeavers(branch.id, last30),
      this.principals(branch.id, now),
      this.queries.feeSnapshot(
        branch.id,
        now.getUTCFullYear(),
        now.getUTCMonth() + 1,
      ),
    ]);
    const base = {
      currency: branch.currency,
      attendance: { now: attendanceNow, prev: attendanceBefore },
      pace,
      parents,
      teacherLeavers: leavers,
      principal,
      receiptsWaitingDays: receipts.oldestPendingAt
        ? daysSince(new Date(receipts.oldestPendingAt), now)
        : null,
    };
    if (!year)
      return {
        ...base,
        enrolled: null,
        pass: null,
        collectionRate: null,
        overdue: null,
        teachingGaps: null,
        timetable: null,
        registers: null,
        exams: null,
        belowFloor: null,
      };

    const [
      enrolment,
      summary,
      staff,
      tt,
      passNow,
      passBefore,
      registers,
      exams,
      below,
      belowBefore,
    ] = await Promise.all([
      this.queries.enrolment(branch.id, year.id),
      this.feeReports.summary({ academicYearId: year.id }, ctx.actor),
      this.queries.staffing(branch.id, year.id),
      this.queries.cached(branch.id, 'tt', { ay: year.id }, 60, () =>
        this.timetable.getOverview(ctx.actor, { academicYearId: year.id }),
      ),
      this.passRate(branch.id, year),
      priorYear ? this.passRate(branch.id, priorYear) : null,
      this.registers(branch.id, year.id, now),
      this.exams(branch.id, year.id, now),
      this.queries.attendanceRisk(branch.id, year.id, last30),
      this.queries.attendanceRisk(branch.id, year.id, before30),
    ]);
    return {
      ...base,
      enrolled: enrolment.reduce((s, r) => s + r.n, 0),
      pass: { now: passNow, prev: passBefore },
      collectionRate: ratio(summary.totalCollected, summary.totalExpected),
      overdue: summary.overdueAmount,
      teachingGaps: staff.uncovered + staff.noClassTeacher,
      timetable: {
        published: tt.counts.published,
        sections: tt.counts.total,
        sessionDays: daysSince((currentYear ?? year).startDate, now),
      },
      registers,
      exams,
      belowFloor: { now: below.below, prev: belowBefore.below },
    };
  }

  private async attendanceRate(ctx: BranchContext, range: RangeWindow) {
    const stats = await this.attendance.getSchoolStats(ctx.actor, {
      from: range.window.from,
      to: range.window.to,
    });
    return ratio(stats.range.present + stats.range.late, stats.range.total);
  }

  private async passRate(schoolId: string, year: YearRef) {
    const rows = await this.queries.examResults(schoolId, year.id);
    return ratio(
      rows.reduce((s, r) => s + r.passed, 0),
      rows.reduce((s, r) => s + r.decided, 0),
    );
  }

  /** This month at today against last month at the same day of the month. */
  private async pace(schoolId: string, now: Date) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const dayCount = now.getUTCDate();
    // On the 31st, a 30-day month is judged at its end, not a day into the next.
    const cutoff = (year: number, month: number) =>
      new Date(
        Math.min(
          Date.UTC(year, month, 1) + dayCount * DAY_MS,
          Date.UTC(year, month + 1, 1),
        ),
      );
    const prevMonth = new Date(Date.UTC(y, m - 1, 1));
    const [thisMonth, lastMonth] = await Promise.all([
      this.queries.collectionPace(schoolId, y, m + 1, cutoff(y, m)),
      this.queries.collectionPace(
        schoolId,
        prevMonth.getUTCFullYear(),
        prevMonth.getUTCMonth() + 1,
        cutoff(prevMonth.getUTCFullYear(), prevMonth.getUTCMonth()),
      ),
    ]);
    return {
      now: ratio(thisMonth.paid, thisMonth.billed),
      prev: ratio(lastMonth.paid, lastMonth.billed),
    };
  }

  private async parentSignIns(
    schoolId: string,
    last30: RangeWindow,
    before30: RangeWindow,
  ) {
    const [now, before] = await Promise.all([
      this.queries.adoption(schoolId, last30),
      this.queries.adoption(schoolId, before30),
    ]);
    const parents = (
      rows: { role: string; active: number; signedIn: number }[],
    ) => {
      const row = rows.find((r) => r.role === Role.PARENT);
      return ratio(row?.signedIn ?? 0, row?.active ?? 0);
    };
    return { now: parents(now), prev: parents(before) };
  }

  private async registers(schoolId: string, ayId: string, now: Date) {
    const [rows, workingDays] = await Promise.all([
      this.queries.sectionRegisters(schoolId, ayId, now),
      this.queries.workingDays(schoolId),
    ]);
    const silentSince = (n: number) => {
      const since = nthWorkingDayBack(workingDays, now, n);
      return rows.filter((r) => !r.lastMarked || new Date(r.lastMarked) < since)
        .length;
    };
    return {
      silent3: silentSince(3),
      silent5: silentSince(5),
      of: rows.length,
    };
  }

  private async exams(schoolId: string, ayId: string, now: Date) {
    const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);
    const [backlog, overdue7, overdue14] = await Promise.all([
      this.queries.examBacklog(schoolId),
      this.queries.unfinalizedExams(schoolId, ayId, daysAgo(7)),
      this.queries.unfinalizedExams(schoolId, ayId, daysAgo(14)),
    ]);
    return {
      reviewWaitingDays: backlog.oldestSubmittedAt
        ? daysSince(new Date(backlog.oldestSubmittedAt), now)
        : null,
      overdue7,
      overdue14,
    };
  }

  private async principals(schoolId: string, now: Date) {
    const active = await this.prisma.user.findMany({
      where: { schoolId, role: Role.SCHOOL_ADMIN, isActive: true },
      select: { id: true },
    });
    if (active.length === 0) return { active: 0, daysSinceLogin: null };
    // Only who and when: audit metadata can carry other people's names (M19).
    const last = await this.prisma.auditLog.aggregate({
      where: { actorUserId: { in: active.map((u) => u.id) }, action: 'LOGIN' },
      _max: { createdAt: true },
    });
    return {
      active: active.length,
      daysSinceLogin: last._max.createdAt
        ? daysSince(last._max.createdAt, now)
        : null,
    };
  }

  private rollUp(rows: BranchResult<OverviewData>[]): OverviewGroup {
    const withData = rows.filter((r) => r.data);
    const ok = withData.filter((r) => r.status === 'ok');
    const rates = ok.map((r) => r.data!.collectionRate?.value);
    return {
      enrolled: ok.reduce((s, r) => s + (r.data!.enrolled ?? 0), 0),
      attendance: {
        now: sumRatio(withData.map((r) => r.data!.attendance.now)),
        prev: sumRatio(withData.map((r) => r.data!.attendance.prev)),
      },
      pass: {
        now: sumRatio(
          ok.flatMap((r) => (r.data!.pass ? [r.data!.pass.now] : [])),
        ),
        prev: sumRatio(
          ok.flatMap((r) => (r.data!.pass?.prev ? [r.data!.pass.prev] : [])),
        ),
      },
      collection: {
        average: mean(rates),
        branches: rates.filter((v) => v !== null && v !== undefined).length,
        paceNow: mean(withData.map((r) => r.data!.pace.now.value)),
        pacePrev: mean(withData.map((r) => r.data!.pace.prev.value)),
      },
    };
  }
}
