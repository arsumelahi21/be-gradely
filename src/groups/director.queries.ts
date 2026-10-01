import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/services/cache.service';
import { RangeWindow, lastTwelveMonths, rangeTtl } from './insights';

export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CHEQUE',
  'ONLINE',
  'OTHER',
] as const;
export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number];

export interface EnrolmentRow {
  sectionId: string;
  classGradeId: string;
  className: string;
  level: number | null;
  gender: string | null;
  n: number;
}

/**
 * Read-only director queries (00 §6). Every one binds schoolId in its WHERE and is cached
 * per branch only: nothing is keyed by group or director, so a detach is never served stale.
 */
@Injectable()
export class DirectorQueriesService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  cached<T>(
    schoolId: string,
    metric: string,
    variant: object,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (!schoolId) throw new Error('A director cache key needs a schoolId');
    return this.cache.wrap(
      `director:b:${schoolId}:${metric}:${JSON.stringify(variant)}`,
      ttlSeconds,
      compute,
    );
  }

  /** Q1f: this month's live challans and the receipt queue, in one round trip. */
  feeSnapshot(schoolId: string, year: number, month: number) {
    return this.cached(
      schoolId,
      'q1-fees',
      { y: year, m: month },
      60,
      async () => {
        const [row] = await this.prisma.$queryRaw<
          {
            billedThisMonth: number;
            pendingReceipts: number;
            oldestPendingAt: Date | null;
          }[]
        >`
        SELECT (SELECT COUNT(*)::int FROM "Challan"
                 WHERE "schoolId" = ${schoolId} AND "periodYear" = ${year}
                   AND "periodMonth" = ${month} AND "status" <> 'CANCELLED') AS "billedThisMonth",
               (SELECT COUNT(*)::int FROM "PaymentSubmission"
                 WHERE "schoolId" = ${schoolId}
                   AND "status" = 'PENDING_VERIFICATION') AS "pendingReceipts",
               (SELECT MIN("createdAt") FROM "PaymentSubmission"
                 WHERE "schoolId" = ${schoolId}
                   AND "status" = 'PENDING_VERIFICATION') AS "oldestPendingAt"`;
        return {
          billedThisMonth: row.billedThisMonth,
          pendingReceipts: row.pendingReceipts,
          oldestPendingAt: row.oldestPendingAt
            ? new Date(row.oldestPendingAt).toISOString()
            : null,
        };
      },
    );
  }

  /** Q2: cash by payment date. Voided payments never count; paidAt is a timestamp. */
  cash(schoolId: string, range: RangeWindow) {
    const { from, to } = range.window;
    return this.cached(
      schoolId,
      'q2-cash',
      { from, to },
      rangeTtl(range.days),
      async () => {
        const rows = await this.prisma.$queryRaw<
          { method: PaymentMethodKey; count: number; amount: bigint | null }[]
        >`
          SELECT "method"::text AS method, COUNT(*)::int AS count, SUM("amount")::bigint AS amount
            FROM "Payment"
           WHERE "schoolId" = ${schoolId} AND "voidedAt" IS NULL
             AND "paidAt" >= ${range.start} AND "paidAt" < ${range.endExclusive}
           GROUP BY "method"`;
        return rows.map((r) => ({
          method: r.method,
          count: r.count,
          amount: Number(r.amount ?? 0),
        }));
      },
    );
  }

  /** Q2m: cash per calendar month, the 12 months ending this one. */
  cashMonthly(schoolId: string, now: Date) {
    const { months, start } = lastTwelveMonths(now);
    return this.cached(
      schoolId,
      'q2-cash-monthly',
      { to: months[11] },
      300,
      async () => {
        const rows = await this.prisma.$queryRaw<
          { month: string; amount: bigint | null }[]
        >`
          SELECT to_char(date_trunc('month', "paidAt"), 'YYYY-MM') AS month,
                 SUM("amount")::bigint AS amount
            FROM "Payment"
           WHERE "schoolId" = ${schoolId} AND "voidedAt" IS NULL
             AND "paidAt" >= ${start}
           GROUP BY 1`;
        const byMonth = new Map(
          rows.map((r) => [r.month, Number(r.amount ?? 0)]),
        );
        return months.map((month) => ({
          month,
          amount: byMonth.get(month) ?? 0,
        }));
      },
    );
  }

  /**
   * Q4a: canonical enrolled students (00 §6) by section and gender. The partial unique
   * index Enrollment_one_active_per_year means COUNT(*) needs no DISTINCT.
   */
  enrolment(schoolId: string, academicYearId: string) {
    return this.cached(
      schoolId,
      'q4-enrolment',
      { ay: academicYearId },
      60,
      () =>
        this.prisma.$queryRaw<EnrolmentRow[]>(Prisma.sql`
          SELECT e."sectionId", s."classGradeId", cg."name" AS "className", cg."level",
                 sp."gender"::text AS gender, COUNT(*)::int AS n
            FROM "Enrollment" e
            JOIN "Section" s         ON s."id"  = e."sectionId"
            JOIN "ClassGrade" cg     ON cg."id" = s."classGradeId"
            JOIN "StudentProfile" sp ON sp."id" = e."studentId"
            LEFT JOIN "User" u       ON u."id"  = sp."userId"
           WHERE s."schoolId" = ${schoolId} AND sp."schoolId" = ${schoolId}
             AND e."academicYearId" = ${academicYearId} AND e."status" = 'ACTIVE'
             AND sp."isActive" = true AND (u."id" IS NULL OR u."isActive" = true)
           GROUP BY 1, 2, 3, 4, 5`),
    );
  }

  /** Q4s: sections that can take students (both the section and its class active). */
  activeSections(schoolId: string) {
    return this.cached(schoolId, 'q4-sections', {}, 60, () =>
      this.prisma.section.findMany({
        where: { schoolId, isActive: true, classGrade: { isActive: true } },
        select: {
          id: true,
          classGrade: { select: { name: true, level: true } },
        },
      }),
    );
  }

  /**
   * Q4b: active students with no ACTIVE placement in the session, and inactive profiles.
   * A null year (no_year branch) leaves every student unplaced; the caller reports null then.
   */
  roster(schoolId: string, academicYearId: string | null) {
    return this.cached(
      schoolId,
      'q4-roster',
      { ay: academicYearId },
      60,
      async () => {
        const [row] = await this.prisma.$queryRaw<
          { unplaced: number; inactive: number }[]
        >`
          SELECT COUNT(*) FILTER (WHERE t.active AND NOT t.placed)::int AS unplaced,
                 COUNT(*) FILTER (WHERE NOT t.active)::int              AS inactive
            FROM (SELECT (sp."isActive" AND (u."id" IS NULL OR u."isActive")) AS active,
                         EXISTS (SELECT 1 FROM "Enrollment" e
                                  WHERE e."studentId" = sp."id"
                                    AND e."academicYearId" = ${academicYearId}
                                    AND e."status" = 'ACTIVE') AS placed
                    FROM "StudentProfile" sp
                    LEFT JOIN "User" u ON u."id" = sp."userId"
                   WHERE sp."schoolId" = ${schoolId}) t`;
        return row;
      },
    );
  }

  /**
   * Q3: admissions by joining date, else the record date. A student who left later was
   * still admitted, so no active filter.
   */
  admissions(schoolId: string, range: RangeWindow) {
    const { from, to } = range.window;
    return this.cached(
      schoolId,
      'q3-admissions',
      { from, to },
      rangeTtl(range.days),
      async () => {
        const [row] = await this.prisma.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM "StudentProfile"
           WHERE "schoolId" = ${schoolId}
             AND COALESCE("dateOfJoining", "createdAt") >= ${range.start}
             AND COALESCE("dateOfJoining", "createdAt") <  ${range.endExclusive}`;
        return row.n;
      },
    );
  }

  /** Q3m: admissions per calendar month, the 12 months ending this one. */
  admissionsMonthly(schoolId: string, now: Date) {
    const { months, start } = lastTwelveMonths(now);
    return this.cached(
      schoolId,
      'q3-admissions-monthly',
      { to: months[11] },
      300,
      async () => {
        const rows = await this.prisma.$queryRaw<
          { month: string; n: number }[]
        >`
          SELECT to_char(date_trunc('month', COALESCE("dateOfJoining", "createdAt")), 'YYYY-MM') AS month,
                 COUNT(*)::int AS n
            FROM "StudentProfile"
           WHERE "schoolId" = ${schoolId}
             AND COALESCE("dateOfJoining", "createdAt") >= ${start}
           GROUP BY 1`;
        const byMonth = new Map(rows.map((r) => [r.month, r.n]));
        return months.map((month) => ({
          month,
          count: byMonth.get(month) ?? 0,
        }));
      },
    );
  }
}
