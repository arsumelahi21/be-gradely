import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeeReportsService } from '../fees/fee-reports.service';
import { AttendanceService } from '../attendance/attendance.service';
import { Role } from '../common/types/role.type';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
} from './director.service';
import { DirectorQueriesService } from './director.queries';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { Ratio, daysSince, ratio, resolveWindow } from './insights';

/** One row per branch: the figure from each tab that most needs watching. */
export interface OverviewData {
  currency: string;
  enrolled: number | null;
  /** Always the last 30 days, whatever the page filter, so the overview reads the same every visit. */
  attendance: Ratio;
  collectionRate: Ratio | null;
  overdue: number | null;
  receiptsWaitingDays: number | null;
  teachingGaps: number | null;
  principal: { active: number; daysSinceLogin: number | null };
}

export interface OverviewGroup {
  enrolled: number;
  attendance: Ratio;
  /** Per currency: never added across currencies. */
  collectionRate: Record<string, Ratio>;
}

/** Overview (01-OVERVIEW.md, simplified): a scorecard built from the same cached figures as the tabs. */
@Injectable()
export class DirectorOverviewService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
    private prisma: PrismaService,
    private feeReports: FeeReportsService,
    private attendance: AttendanceService,
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
    const { actor, branch, year, now } = ctx;
    const last30 = resolveWindow({}, now).window;
    const [stats, enrolment, summary, snapshot, staff, principals] =
      await Promise.all([
        this.attendance.getSchoolStats(actor, {
          from: last30.from,
          to: last30.to,
        }),
        year ? this.queries.enrolment(branch.id, year.id) : null,
        year
          ? this.feeReports.summary({ academicYearId: year.id }, actor)
          : null,
        this.queries.feeSnapshot(
          branch.id,
          now.getUTCFullYear(),
          now.getUTCMonth() + 1,
        ),
        year ? this.queries.staffing(branch.id, year.id) : null,
        this.principals(branch.id, now),
      ]);
    const marks = stats.range;
    return {
      currency: branch.currency,
      enrolled: enrolment ? enrolment.reduce((s, r) => s + r.n, 0) : null,
      attendance: ratio(marks.present + marks.late, marks.total),
      collectionRate:
        summary && ratio(summary.totalCollected, summary.totalExpected),
      overdue: summary ? summary.overdueAmount : null,
      receiptsWaitingDays: snapshot.oldestPendingAt
        ? daysSince(new Date(snapshot.oldestPendingAt), now)
        : null,
      teachingGaps: staff ? staff.uncovered + staff.noClassTeacher : null,
      principal: principals,
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
    let enrolled = 0;
    let attended = 0;
    let marks = 0;
    const money: Record<string, { num: number; den: number }> = {};
    for (const { status, data } of rows) {
      if (!data) continue;
      attended += data.attendance.num;
      marks += data.attendance.den;
      if (status !== 'ok') continue;
      enrolled += data.enrolled ?? 0;
      if (data.collectionRate) {
        const c = (money[data.currency] ??= { num: 0, den: 0 });
        c.num += data.collectionRate.num;
        c.den += data.collectionRate.den;
      }
    }
    return {
      enrolled,
      attendance: ratio(attended, marks),
      collectionRate: Object.fromEntries(
        Object.entries(money).map(([cur, c]) => [cur, ratio(c.num, c.den)]),
      ),
    };
  }
}
