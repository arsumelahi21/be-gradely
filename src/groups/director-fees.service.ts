import { BadRequestException, Injectable } from '@nestjs/common';
import { FeeReportsService } from '../fees/fee-reports.service';
import { ChallansService } from '../fees/challans.service';
import { AuditLogService } from '../audit/audit.service';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
  YearRef,
} from './director.service';
import {
  DirectorQueriesService,
  PAYMENT_METHODS,
  PaymentMethodKey,
} from './director.queries';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { Ratio, daysSince, meanRate, ratio } from './insights';

type Minor = number;
type ByMethod = Record<PaymentMethodKey, { amount: Minor; count: number }>;

interface StatusMix {
  paid: number;
  partiallyPaid: number;
  unpaid: number;
  overdue: number;
}

interface TrendPoint {
  month: string;
  billed: Minor;
  collected: Minor;
}

interface PerStudent {
  num: Minor;
  den: number;
  value: Minor | null;
}

interface Accrual {
  billed: Minor;
  gross: Minor;
  discounts: Minor;
  collected: Minor;
  outstanding: Minor;
  collectionRate: Ratio;
  discountShare: Ratio;
  overdue: { amount: Minor; count: number };
  challans: { live: number; cancelled: number };
  statusMix: StatusMix;
  trend: TrendPoint[];
  billedPerStudent: PerStudent;
}

interface Cash {
  received: Minor;
  count: number;
  byMethod: ByMethod;
  monthly: { month: string; amount: Minor }[];
}

type CoverageStatus = 'CREATED' | 'PARTIAL' | 'NOT_CREATED' | 'NO_STUDENTS';

interface Coverage {
  period: { year: number; month: number };
  dueDay: number;
  pastDueDay: boolean;
  classes: {
    created: number;
    partial: number;
    notCreated: number;
    noStudents: number;
    total: number;
  };
  rows?: {
    className: string;
    status: CoverageStatus;
    students: number;
    challans: number;
    billed: Minor;
    collected: Minor;
  }[];
}

export interface FeesData {
  currency: string;
  accrual: Accrual | null;
  cash: Cash;
  queue: {
    pendingReceipts: number;
    oldestPendingAt: string | null;
    oldestAgeDays: number | null;
  };
  billedThisMonth: number;
  /** This month's bills paid by today, against last month's by the same day. */
  pace: { now: Ratio; prev: Ratio };
  defaulters: number | null;
  coverage: Coverage | null;
  byClass?: {
    className: string;
    billed: Minor;
    collected: Minor;
    challans: number;
    collectionRate: Ratio;
  }[];
}

interface CurrencyTotals {
  branches: number;
  billed: Minor;
  gross: Minor;
  discounts: Minor;
  collected: Minor;
  outstanding: Minor;
  collectionRate: Ratio;
  discountShare: Ratio;
  overdue: { amount: Minor; count: number };
  trend: TrendPoint[];
  billedPerStudent: PerStudent;
  cash: Cash;
}

export interface FeesGroup {
  byCurrency: Record<string, CurrencyTotals>;
  /** Averages of branch rates, so currencies never mix. */
  pace: { now: number | null; prev: number | null };
  defaulters: number;
  statusMix: StatusMix;
  queue: { pendingReceipts: number; oldestAgeDays: number | null };
  coverage: {
    branchesPastDueWithUnbilled: number;
    notCreated: number;
    partial: number;
  };
}

export interface FeesLists {
  outstanding: {
    currency: string;
    rows: {
      fullName: string;
      className: string | null;
      sectionName: string | null;
      amount: Minor;
      overdueCount: number;
    }[];
  };
}

const STATUS_KEY: Record<string, keyof StatusMix> = {
  PAID: 'paid',
  PARTIALLY_PAID: 'partiallyPaid',
  UNPAID: 'unpaid',
  OVERDUE: 'overdue',
};

const emptyByMethod = (): ByMethod =>
  Object.fromEntries(
    PAYMENT_METHODS.map((m) => [m, { amount: 0, count: 0 }]),
  ) as ByMethod;

const perStudent = (num: Minor, den: number): PerStudent => ({
  num,
  den,
  value: den === 0 ? null : Math.round(num / den),
});

/** Fees & Revenue (03-FEES.md). Accrual is per session; cash is by payment date; they never mix. */
@Injectable()
export class DirectorFeesService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
    private feeReports: FeeReportsService,
    private challans: ChallansService,
    private audit: AuditLogService,
  ) {}

  insights(scope: DirectorScope, query: InsightsQueryDto) {
    return this.director.insights<FeesData, FeesGroup>(
      scope,
      query,
      (ctx) => this.branchFees(ctx),
      (rows) => this.rollUp(rows),
    );
  }

  async lists(scope: DirectorScope, query: InsightsQueryDto) {
    if (!query.branch || query.branch === 'all')
      throw new BadRequestException('Choose one branch to see names');
    const result = await this.director.insights<FeesLists | null, null>(
      scope,
      query,
      async ({ year, actor, branch }) => {
        if (!year) return null;
        // The DTO keys and their order match the principal's reports page, so they share its cache.
        const rows = await this.feeReports.outstanding(
          { academicYearId: year.id, limit: 10 },
          actor,
        );
        return {
          outstanding: {
            currency: branch.currency,
            rows: rows.map((r) => ({
              fullName: r.fullName,
              className: r.className,
              sectionName: r.sectionName,
              amount: r.outstanding,
              overdueCount: r.overdueChallans,
            })),
          },
        };
      },
      () => null,
      { oneAtATime: false },
    );
    void this.audit.record(scope.directorId, 'DIRECTOR_LIST_VIEW', {
      schoolId: query.branch,
      entityType: 'School',
      entityId: query.branch,
      metadata: { module: 'fees' },
    });
    return result;
  }

  async branchFees(ctx: BranchContext): Promise<FeesData> {
    const { branch, year, currentYear, now, range } = ctx;
    const thisYear = now.getUTCFullYear();
    const thisMonth = now.getUTCMonth() + 1;
    const [
      snapshot,
      cashRows,
      monthly,
      accrual,
      coverage,
      byClass,
      pace,
      defaulters,
    ] = await Promise.all([
      this.queries.feeSnapshot(branch.id, thisYear, thisMonth),
      this.queries.cash(branch.id, range),
      this.queries.cashMonthly(branch.id, now),
      year ? this.accrual(ctx, year) : null,
      currentYear ? this.coverage(ctx, currentYear) : null,
      ctx.single && year ? this.byClass(ctx, year) : undefined,
      this.queries.pace(branch.id, now),
      year ? this.queries.defaulters(branch.id, year.id, now) : null,
    ]);

    const byMethod = emptyByMethod();
    for (const r of cashRows)
      byMethod[r.method] = { amount: r.amount, count: r.count };
    const oldest = snapshot.oldestPendingAt
      ? new Date(snapshot.oldestPendingAt)
      : null;

    return {
      currency: branch.currency,
      accrual,
      cash: {
        received: cashRows.reduce((s, r) => s + r.amount, 0),
        count: cashRows.reduce((s, r) => s + r.count, 0),
        byMethod,
        monthly,
      },
      queue: {
        pendingReceipts: snapshot.pendingReceipts,
        oldestPendingAt: snapshot.oldestPendingAt,
        oldestAgeDays: oldest ? daysSince(oldest, now) : null,
      },
      billedThisMonth: snapshot.billedThisMonth,
      pace,
      defaulters,
      coverage,
      ...(byClass && { byClass }),
    };
  }

  // Never pass a preset or dates here: in the fee reports they filter issueDate, which would
  // turn "billed this session" into "issued in this window" (03 §1).
  private async accrual(ctx: BranchContext, year: YearRef): Promise<Accrual> {
    const { actor, branch } = ctx;
    const [summary, trend, status, enrolment] = await Promise.all([
      this.feeReports.summary({ academicYearId: year.id }, actor),
      this.feeReports.collectionTrend(
        { academicYearId: year.id, months: 12 },
        actor,
      ),
      this.feeReports.statusBreakdown({ academicYearId: year.id }, actor),
      this.queries.enrolment(branch.id, year.id),
    ]);
    const statusMix: StatusMix = {
      paid: 0,
      partiallyPaid: 0,
      unpaid: 0,
      overdue: 0,
    };
    for (const s of status) statusMix[STATUS_KEY[s.status]] = s.count;
    const enrolled = enrolment.reduce((s, r) => s + r.n, 0);

    return {
      billed: summary.totalExpected,
      gross: summary.totalGross,
      discounts: summary.totalDiscounts,
      collected: summary.totalCollected,
      outstanding: summary.totalPending,
      // Rebuilt from the sums: the summary reports 100% when nothing is billed (00 §5.5).
      collectionRate: ratio(summary.totalCollected, summary.totalExpected),
      discountShare: ratio(summary.totalDiscounts, summary.totalGross),
      overdue: { amount: summary.overdueAmount, count: summary.overdueCount },
      challans: {
        live: summary.challanCount,
        cancelled: summary.cancelledCount,
      },
      statusMix,
      trend: trend.map((t) => ({
        month: t.bucket,
        billed: t.billed,
        collected: t.collected,
      })),
      billedPerStudent: perStudent(summary.totalExpected, enrolled),
    };
  }

  /** This month's billing always reads the current session, even when ay=previous. */
  private async coverage(
    ctx: BranchContext,
    currentYear: YearRef,
  ): Promise<Coverage> {
    const { actor, branch, now, single } = ctx;
    const period = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
    const result = await this.queries.cached(
      branch.id,
      'coverage',
      { ay: currentYear.id, y: period.year, m: period.month },
      60,
      () =>
        this.challans.coverage(
          {
            academicYearId: currentYear.id,
            periodYear: period.year,
            periodMonth: period.month,
          },
          actor,
        ),
    );
    const count = (status: CoverageStatus) =>
      result.rows.filter((r) => r.status === status).length;
    return {
      period,
      dueDay: branch.feeDueDayOfMonth,
      pastDueDay: now.getUTCDate() > branch.feeDueDayOfMonth,
      classes: {
        created: count('CREATED'),
        partial: count('PARTIAL'),
        notCreated: count('NOT_CREATED'),
        noStudents: count('NO_STUDENTS'),
        total: result.rows.length,
      },
      ...(single && {
        rows: result.rows.map((r) => ({
          className: r.className,
          status: r.status as CoverageStatus,
          students: r.students,
          challans: r.challans,
          billed: r.billed,
          collected: r.collected,
        })),
      }),
    };
  }

  private async byClass(ctx: BranchContext, year: YearRef) {
    const rows = await this.feeReports.byClass(
      { academicYearId: year.id },
      ctx.actor,
    );
    return rows.map((r) => ({
      className: r.className,
      billed: r.expected,
      collected: r.collected,
      challans: r.challans,
      collectionRate: ratio(r.collected, r.expected),
    }));
  }

  /** Money never crosses currencies; accrual comes only from branches with a session (00 §5.6). */
  private rollUp(rows: BranchResult<FeesData>[]): FeesGroup {
    const byCurrency: Record<string, CurrencyTotals> = {};
    const statusMix: StatusMix = {
      paid: 0,
      partiallyPaid: 0,
      unpaid: 0,
      overdue: 0,
    };
    const queue = { pendingReceipts: 0, oldestAgeDays: null as number | null };
    const coverage = {
      branchesPastDueWithUnbilled: 0,
      notCreated: 0,
      partial: 0,
    };
    const trends: Record<string, Map<string, TrendPoint>> = {};
    const monthlies: Record<string, Map<string, number>> = {};

    for (const row of rows) {
      const d = row.data;
      if (!d) continue;
      const c = (byCurrency[d.currency] ??= {
        branches: 0,
        billed: 0,
        gross: 0,
        discounts: 0,
        collected: 0,
        outstanding: 0,
        collectionRate: ratio(0, 0),
        discountShare: ratio(0, 0),
        overdue: { amount: 0, count: 0 },
        trend: [],
        billedPerStudent: perStudent(0, 0),
        cash: { received: 0, count: 0, byMethod: emptyByMethod(), monthly: [] },
      });
      c.branches++;
      c.cash.received += d.cash.received;
      c.cash.count += d.cash.count;
      for (const m of PAYMENT_METHODS) {
        c.cash.byMethod[m].amount += d.cash.byMethod[m].amount;
        c.cash.byMethod[m].count += d.cash.byMethod[m].count;
      }
      const monthly = (monthlies[d.currency] ??= new Map());
      for (const p of d.cash.monthly)
        monthly.set(p.month, (monthly.get(p.month) ?? 0) + p.amount);

      queue.pendingReceipts += d.queue.pendingReceipts;
      if (d.queue.oldestAgeDays !== null)
        queue.oldestAgeDays = Math.max(
          queue.oldestAgeDays ?? 0,
          d.queue.oldestAgeDays,
        );

      const a = d.accrual;
      if (row.status !== 'ok' || !a) continue;
      c.billed += a.billed;
      c.gross += a.gross;
      c.discounts += a.discounts;
      c.collected += a.collected;
      c.outstanding += a.outstanding;
      c.overdue.amount += a.overdue.amount;
      c.overdue.count += a.overdue.count;
      c.billedPerStudent.num += a.billedPerStudent.num;
      c.billedPerStudent.den += a.billedPerStudent.den;
      for (const k of Object.keys(statusMix) as (keyof StatusMix)[])
        statusMix[k] += a.statusMix[k];
      const trend = (trends[d.currency] ??= new Map());
      for (const t of a.trend) {
        const p = trend.get(t.month) ?? {
          month: t.month,
          billed: 0,
          collected: 0,
        };
        p.billed += t.billed;
        p.collected += t.collected;
        trend.set(t.month, p);
      }
      if (d.coverage) {
        coverage.notCreated += d.coverage.classes.notCreated;
        coverage.partial += d.coverage.classes.partial;
        if (d.coverage.pastDueDay && d.coverage.classes.notCreated > 0)
          coverage.branchesPastDueWithUnbilled++;
      }
    }

    for (const [currency, c] of Object.entries(byCurrency)) {
      c.collectionRate = ratio(c.collected, c.billed);
      c.discountShare = ratio(c.discounts, c.gross);
      c.billedPerStudent = perStudent(
        c.billedPerStudent.num,
        c.billedPerStudent.den,
      );
      c.trend = [...(trends[currency]?.values() ?? [])].sort((x, y) =>
        x.month.localeCompare(y.month),
      );
      c.cash.monthly = [...(monthlies[currency]?.entries() ?? [])]
        .map(([month, amount]) => ({ month, amount }))
        .sort((x, y) => x.month.localeCompare(y.month));
    }
    const withData = rows.filter((r) => r.data);
    return {
      byCurrency,
      pace: {
        now: meanRate(withData.map((r) => r.data!.pace.now.value)),
        prev: meanRate(withData.map((r) => r.data!.pace.prev.value)),
      },
      defaulters: withData.reduce((s, r) => s + (r.data!.defaulters ?? 0), 0),
      statusMix,
      queue,
      coverage,
    };
  }
}
