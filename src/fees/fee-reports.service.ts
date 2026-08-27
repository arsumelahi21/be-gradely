import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { CacheService } from '../common/services/cache.service';
import { Actor } from '../common/types/actor.type';
import {
  ChallanStatus,
  PaymentSubmissionStatus,
  TrendGranularity,
} from './fees.types';
import {
  resolveReportPreset,
  trendGranularity,
  type DateWindow,
} from './fee-calculator';
import { FeeReportQueryDto } from './dto/fee-report-query.dto';
import { FEE_REPORT_CACHE_TTL_SECONDS, feesCacheKey } from './fees-cache';

/** UTC midnight, matching the `@db.Date` columns. */
const utcMidnight = (v: string | Date) => {
  const d = new Date(v);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
};
const todayUtc = () => {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
};

/**
 * Fee reporting. Aggregation happens in SQL, never in Node — matching how
 * DashboardService computes its stats. Cached briefly per school and cleared
 * on every money-touching write.
 */
@Injectable()
export class FeeReportsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  /** Headline figures for the summary cards. */
  async summary(query: FeeReportQueryDto, actor: Actor) {
    const schoolId = this.scope(actor, query);
    return this.cached(schoolId, ['summary', query], async () => {
      const where = this.buildWhere(schoolId, query);
      const today = todayUtc();

      const [totals, byStatus, overdue, cancelled, pendingVerification] =
        await Promise.all([
          this.prisma.challan.aggregate({
            where,
            _sum: {
              grossAmount: true,
              discountAmount: true,
              netAmount: true,
              paidAmount: true,
            },
            _count: { _all: true },
          }),
          this.prisma.challan.groupBy({
            by: ['status'],
            where,
            _count: { _all: true },
            _sum: { netAmount: true, paidAmount: true },
          }),
          this.prisma.challan.aggregate({
            where: {
              ...where,
              dueDate: { lt: today },
              status: {
                in: [ChallanStatus.UNPAID, ChallanStatus.PARTIALLY_PAID],
              },
            },
            _count: { _all: true },
            _sum: { netAmount: true, paidAmount: true },
          }),
          // Cancelled sits OUTSIDE `where`, which excludes it from every revenue
          // figure. Counted separately so "total ever issued" is answerable
          // without polluting the money.
          this.prisma.challan.count({
            where: { ...where, status: ChallanStatus.CANCELLED },
          }),
          // Receipts awaiting review. Scoped to the school only — a submission is
          // evidence, not a challan, so the challan filters (class, period, date
          // window) have no meaning for it.
          this.prisma.paymentSubmission.count({
            where: {
              schoolId,
              status: PaymentSubmissionStatus.PENDING_VERIFICATION,
            },
          }),
        ]);

      const expected = totals._sum.netAmount ?? 0;
      const collected = totals._sum.paidAmount ?? 0;
      const counts = Object.fromEntries(
        byStatus.map((s) => [s.status, s._count._all]),
      ) as Record<string, number>;

      return {
        totalExpected: expected,
        totalCollected: collected,
        totalPending: Math.max(0, expected - collected),
        totalDiscounts: totals._sum.discountAmount ?? 0,
        totalGross: totals._sum.grossAmount ?? 0,
        overdueAmount: Math.max(
          0,
          (overdue._sum.netAmount ?? 0) - (overdue._sum.paidAmount ?? 0),
        ),
        // Percent with one decimal; 100% when there is nothing to collect.
        collectionRate:
          expected === 0 ? 100 : Math.round((collected / expected) * 1000) / 10,
        /** Live challans — what every money figure above is computed from. */
        challanCount: totals._count._all,
        /** Everything ever issued, cancellations included. */
        totalChallanCount: totals._count._all + cancelled,
        paidCount: counts[ChallanStatus.PAID] ?? 0,
        partiallyPaidCount: counts[ChallanStatus.PARTIALLY_PAID] ?? 0,
        unpaidCount: counts[ChallanStatus.UNPAID] ?? 0,
        cancelledCount: cancelled,
        overdueCount: overdue._count._all,
        pendingVerificationCount: pendingVerification,
        // Echo the window the server actually applied, so the page can print
        // "17 May – 17 Aug" instead of leaving the reader to trust a preset name.
        window: this.windowMeta(query),
      };
    });
  }

  /**
   * Collection over time.
   *
   * WITHOUT a date window this keeps its original shape — the last N BILLING
   * periods, grouped by periodYear/periodMonth.
   *
   * WITH a window the buckets follow `issueDate` at a granularity derived from
   * the window's length, because a 7-day filter rendered as one monthly bar is
   * not a trend. Bucketing happens in SQL via `date_trunc`, in a single
   * aggregate query — never by pulling rows into Node.
   */
  async collectionTrend(query: FeeReportQueryDto, actor: Actor) {
    const schoolId = this.scope(actor, query);
    return this.cached(schoolId, ['trend', query], async () => {
      const window = this.resolveWindow(query);

      if (!window) {
        const months = query.months ?? 12;
        const rows = await this.prisma.challan.groupBy({
          by: ['periodYear', 'periodMonth'],
          where: this.buildWhere(schoolId, {
            ...query,
            periodMonth: undefined,
          }),
          _sum: { netAmount: true, paidAmount: true },
          orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
          take: months,
        });
        return rows
          .map((r) => ({
            periodYear: r.periodYear,
            periodMonth: r.periodMonth,
            bucket: `${r.periodYear}-${String(r.periodMonth).padStart(2, '0')}`,
            billed: r._sum.netAmount ?? 0,
            collected: r._sum.paidAmount ?? 0,
          }))
          .reverse(); // chronological for the chart
      }

      const granularity = trendGranularity(window);
      const unit =
        granularity === TrendGranularity.DAY
          ? 'day'
          : granularity === TrendGranularity.WEEK
            ? 'week'
            : 'month';

      // Every filter `buildWhere` applies, expressed as SQL. These must stay in
      // step: a filter honoured by the cards but not the chart puts two
      // contradictory numbers on one screen. The billing period IS filtered
      // here — unlike the no-window branch above, where the buckets are the
      // billing periods themselves and pinning one would collapse the axis to a
      // single bar. Here the buckets are issue dates, so it just narrows.
      const conditions = [
        Prisma.sql`"schoolId" = ${schoolId}`,
        Prisma.sql`"status" <> 'CANCELLED'`,
        Prisma.sql`"issueDate" >= ${window.from}`,
        Prisma.sql`"issueDate" <= ${window.to}`,
        ...(query.academicYearId
          ? [Prisma.sql`"academicYearId" = ${query.academicYearId}`]
          : []),
        ...(query.classGradeId
          ? [Prisma.sql`"classGradeId" = ${query.classGradeId}`]
          : []),
        ...(query.sectionId
          ? [Prisma.sql`"sectionId" = ${query.sectionId}`]
          : []),
        ...(query.periodYear
          ? [Prisma.sql`"periodYear" = ${query.periodYear}`]
          : []),
        ...(query.periodMonth
          ? [Prisma.sql`"periodMonth" = ${query.periodMonth}`]
          : []),
      ];

      // Fully parameterised; `unit` is chosen from a closed set above, never
      // user input, and every value goes through Prisma.sql placeholders.
      const rows = await this.prisma.$queryRaw<
        { bucket: Date; billed: bigint | null; collected: bigint | null }[]
      >`
        SELECT date_trunc(${unit}, "issueDate") AS bucket,
               SUM("netAmount")::bigint  AS billed,
               SUM("paidAmount")::bigint AS collected
          FROM "Challan"
         WHERE ${Prisma.join(conditions, ' AND ')}
         GROUP BY 1
         ORDER BY 1 ASC`;

      return rows.map((r) => {
        const d = new Date(r.bucket);
        return {
          periodYear: d.getUTCFullYear(),
          periodMonth: d.getUTCMonth() + 1,
          bucket: d.toISOString().slice(0, 10),
          granularity,
          billed: Number(r.billed ?? 0),
          collected: Number(r.collected ?? 0),
        };
      });
    });
  }

  /** Paid / Partial / Unpaid / Overdue, carved so the counts sum to the total. */
  async statusBreakdown(query: FeeReportQueryDto, actor: Actor) {
    const schoolId = this.scope(actor, query);
    return this.cached(schoolId, ['status', query], async () => {
      const where = this.buildWhere(schoolId, query);
      const today = todayUtc();
      const unsettled = {
        in: [ChallanStatus.UNPAID, ChallanStatus.PARTIALLY_PAID],
      };

      const [grouped, overdueGrouped] = await Promise.all([
        this.prisma.challan.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        this.prisma.challan.groupBy({
          by: ['status'],
          where: { ...where, dueDate: { lt: today }, status: unsettled },
          _count: { _all: true },
        }),
      ]);

      const count = (s: ChallanStatus) =>
        grouped.find((g) => g.status === s)?._count._all ?? 0;
      const overdueOf = (s: ChallanStatus) =>
        overdueGrouped.find((g) => g.status === s)?._count._all ?? 0;

      // Overdue is carved OUT of unpaid/partial so the segments don't double-count.
      return [
        { status: 'PAID', count: count(ChallanStatus.PAID) },
        {
          status: 'PARTIALLY_PAID',
          count:
            count(ChallanStatus.PARTIALLY_PAID) -
            overdueOf(ChallanStatus.PARTIALLY_PAID),
        },
        {
          status: 'UNPAID',
          count: count(ChallanStatus.UNPAID) - overdueOf(ChallanStatus.UNPAID),
        },
        {
          status: 'OVERDUE',
          count:
            overdueOf(ChallanStatus.UNPAID) +
            overdueOf(ChallanStatus.PARTIALLY_PAID),
        },
      ];
    });
  }

  /** Class-wise expected vs collected — the actionable chart. */
  async byClass(query: FeeReportQueryDto, actor: Actor) {
    const schoolId = this.scope(actor, query);
    return this.cached(schoolId, ['by-class', query], async () => {
      const grouped = await this.prisma.challan.groupBy({
        by: ['classGradeId'],
        where: this.buildWhere(schoolId, query),
        _sum: { netAmount: true, paidAmount: true },
        _count: { _all: true },
      });

      const ids = grouped
        .map((g) => g.classGradeId)
        .filter((id): id is string => !!id);
      const grades = ids.length
        ? await this.prisma.classGrade.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        : [];
      const nameById = new Map(grades.map((g) => [g.id, g.name]));

      return grouped
        .map((g) => ({
          classGradeId: g.classGradeId,
          // Falls back for a class deleted after its challans were issued.
          className: g.classGradeId
            ? (nameById.get(g.classGradeId) ?? 'Removed class')
            : 'Unassigned',
          expected: g._sum.netAmount ?? 0,
          collected: g._sum.paidAmount ?? 0,
          challans: g._count._all,
        }))
        .sort((a, b) => b.expected - a.expected);
    });
  }

  /**
   * Ranked outstanding balances — a table, not a chart: names and amounts are
   * what you act on.
   */
  async outstanding(query: FeeReportQueryDto, actor: Actor) {
    const schoolId = this.scope(actor, query);
    return this.cached(schoolId, ['outstanding', query], async () => {
      const limit = query.limit ?? 20;
      const where = this.buildWhere(schoolId, query);
      const today = todayUtc();

      const grouped = await this.prisma.challan.groupBy({
        by: ['studentId'],
        where: {
          ...where,
          status: { in: [ChallanStatus.UNPAID, ChallanStatus.PARTIALLY_PAID] },
        },
        _sum: { netAmount: true, paidAmount: true },
        _count: { _all: true },
      });

      const ranked = grouped
        .map((g) => ({
          studentId: g.studentId,
          outstanding: Math.max(
            0,
            (g._sum.netAmount ?? 0) - (g._sum.paidAmount ?? 0),
          ),
          challans: g._count._all,
        }))
        .filter((r) => r.outstanding > 0)
        .sort((a, b) => b.outstanding - a.outstanding)
        .slice(0, limit);

      if (!ranked.length) return [];

      const [students, overdueRows] = await Promise.all([
        this.prisma.studentProfile.findMany({
          where: { id: { in: ranked.map((r) => r.studentId) } },
          select: {
            id: true,
            fullName: true,
            rollNo: true,
            enrollments: {
              where: { status: 'ACTIVE' },
              take: 1,
              select: {
                section: {
                  select: {
                    name: true,
                    classGrade: { select: { name: true } },
                  },
                },
              },
            },
          },
        }),
        this.prisma.challan.groupBy({
          by: ['studentId'],
          where: {
            ...where,
            studentId: { in: ranked.map((r) => r.studentId) },
            dueDate: { lt: today },
            status: {
              in: [ChallanStatus.UNPAID, ChallanStatus.PARTIALLY_PAID],
            },
          },
          _count: { _all: true },
        }),
      ]);

      const byId = new Map(students.map((s) => [s.id, s]));
      const overdueById = new Map(
        overdueRows.map((r) => [r.studentId, r._count._all]),
      );

      return ranked.map((r) => {
        const student = byId.get(r.studentId);
        const enrollment = student?.enrollments[0];
        return {
          studentId: r.studentId,
          fullName: student?.fullName ?? 'Unknown',
          rollNo: student?.rollNo ?? null,
          className: enrollment?.section.classGrade.name ?? null,
          sectionName: enrollment?.section.name ?? null,
          outstanding: r.outstanding,
          challans: r.challans,
          overdueChallans: overdueById.get(r.studentId) ?? 0,
        };
      });
    });
  }

  // ---- helpers -----------------------------------------------------------

  private scope(actor: Actor, query: FeeReportQueryDto): string {
    this.ensureAdmin(actor);
    return this.resolveSchoolId(actor, query.schoolId);
  }

  /** Cancelled challans are excluded from every report — they aren't revenue. */
  private buildWhere(
    schoolId: string,
    query: FeeReportQueryDto,
  ): Prisma.ChallanWhereInput {
    const where: Prisma.ChallanWhereInput = {
      schoolId,
      status: { not: ChallanStatus.CANCELLED },
    };
    if (query.academicYearId) where.academicYearId = query.academicYearId;
    if (query.classGradeId) where.classGradeId = query.classGradeId;
    if (query.sectionId) where.sectionId = query.sectionId;
    if (query.periodYear) where.periodYear = query.periodYear;
    if (query.periodMonth) where.periodMonth = query.periodMonth;

    // The window filters on issueDate — the same field `GET /fees/challans`
    // already ranges on, so "challans issued in this window" means one thing
    // across the module. Applied in SQL; nothing is filtered in Node.
    const window = this.resolveWindow(query);
    if (window) {
      where.issueDate = { gte: window.from, lte: window.to };
    }
    return where;
  }

  /**
   * The effective date window: an explicit custom range wins over a preset,
   * and neither is required. Resolved once per request and echoed back to the
   * caller so the UI can print the boundaries it is actually showing.
   */
  private resolveWindow(query: FeeReportQueryDto): DateWindow | null {
    if (query.from || query.to) {
      // A half-open custom range is still meaningful: "since X" / "up to Y".
      const from = query.from ? utcMidnight(query.from) : new Date(0);
      const to = query.to ? utcMidnight(query.to) : todayUtc();
      return { from, to };
    }
    if (query.preset) return resolveReportPreset(query.preset, new Date());
    return null;
  }

  /** Serialisable window for the response payload. */
  private windowMeta(query: FeeReportQueryDto) {
    const w = this.resolveWindow(query);
    if (!w) return null;
    // Report the preset ONLY when it actually produced this window. A custom
    // range wins, and echoing "YEAR" beside a March window would be a lie the
    // UI then repeats to the reader.
    const custom = !!(query.from || query.to);
    return {
      from: w.from.toISOString().slice(0, 10),
      to: w.to.toISOString().slice(0, 10),
      preset: custom ? null : (query.preset ?? null),
      granularity: trendGranularity(w),
    };
  }

  private cached<T>(
    schoolId: string,
    variant: unknown,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (!this.cache) return compute();
    return this.cache.wrap(
      feesCacheKey(schoolId, variant),
      FEE_REPORT_CACHE_TTL_SECONDS,
      compute,
    );
  }
}
