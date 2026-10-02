import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/services/cache.service';
import { RangeWindow, lastTwelveMonths, rangeTtl, ratio } from './insights';

const DAY_MS = 86_400_000;

export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CHEQUE',
  'ONLINE',
  'OTHER',
] as const;
export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number];

// 00 §7: a student is at risk below 75% attendance once they have at least 10 marks.
export const CHRONIC_MIN_MARKS = 10;
const CHRONIC_RATE_PCT = 75;

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

  /**
   * Q5: canonical enrolled students whose attendance in the window is below the floor, among
   * those with enough marks to judge. Integer maths, so exactly 75% is not "below".
   */
  attendanceRisk(schoolId: string, academicYearId: string, range: RangeWindow) {
    const { from, to } = range.window;
    return this.cached(
      schoolId,
      'q5-risk',
      { ay: academicYearId, from, to },
      300,
      async () => {
        const [row] = await this.prisma.$queryRaw<
          { enrolled: number; eligible: number; below: number }[]
        >(Prisma.sql`
          WITH ${this.riskCtes(schoolId, academicYearId, range)}
          SELECT (SELECT COUNT(*)::int FROM enrolled) AS enrolled,
                 COUNT(*) FILTER (WHERE total >= ${CHRONIC_MIN_MARKS})::int AS eligible,
                 COUNT(*) FILTER (WHERE total >= ${CHRONIC_MIN_MARKS}
                                    AND attended * 100 < total * ${CHRONIC_RATE_PCT})::int AS below
            FROM marks`);
        return row;
      },
    );
  }

  /** Q5 list: the five students furthest below the floor. Names, so never cached. */
  attendanceRiskList(
    schoolId: string,
    academicYearId: string,
    range: RangeWindow,
  ) {
    return this.prisma.$queryRaw<
      {
        fullName: string;
        className: string;
        sectionName: string;
        attended: number;
        total: number;
        absent: number;
      }[]
    >(Prisma.sql`
      WITH ${this.riskCtes(schoolId, academicYearId, range)}
      SELECT sp."fullName", cg."name" AS "className", s."name" AS "sectionName",
             m.attended, m.total, m.absent
        FROM marks m
        JOIN enrolled en          ON en."studentId" = m."studentId"
        JOIN "StudentProfile" sp  ON sp."id" = m."studentId"
        JOIN "Section" s          ON s."id" = en."sectionId"
        JOIN "ClassGrade" cg      ON cg."id" = s."classGradeId"
       WHERE m.total >= ${CHRONIC_MIN_MARKS} AND m.attended * 100 < m.total * ${CHRONIC_RATE_PCT}
       ORDER BY m.attended::numeric / m.total, m.absent DESC, sp."fullName"
       LIMIT 5`);
  }

  private riskCtes(
    schoolId: string,
    academicYearId: string,
    range: RangeWindow,
  ) {
    return Prisma.sql`
      enrolled AS (
        SELECT e."studentId", e."sectionId"
          FROM "Enrollment" e
          JOIN "Section" s         ON s."id" = e."sectionId" AND s."schoolId" = ${schoolId}
          JOIN "StudentProfile" sp ON sp."id" = e."studentId" AND sp."isActive"
          LEFT JOIN "User" u       ON u."id" = sp."userId"
         WHERE e."academicYearId" = ${academicYearId} AND e."status" = 'ACTIVE'
           AND (u."id" IS NULL OR u."isActive")
      ), marks AS (
        SELECT a."studentId",
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE a."status" IN ('PRESENT', 'LATE'))::int AS attended,
               COUNT(*) FILTER (WHERE a."status" = 'ABSENT')::int AS absent
          FROM "Attendance" a
          JOIN enrolled en ON en."studentId" = a."studentId"
         WHERE a."schoolId" = ${schoolId}
           AND a."date" >= ${range.start} AND a."date" < ${range.endExclusive}
         GROUP BY a."studentId"
      )`;
  }

  /**
   * Q6: each section that has students this session, with the last day it took a register.
   * Marks belong to the section of their section-subject.
   */
  sectionRegisters(schoolId: string, academicYearId: string, today: Date) {
    return this.cached(
      schoolId,
      'q6-registers',
      { ay: academicYearId, today: today.toISOString().slice(0, 10) },
      60,
      () =>
        this.prisma.$queryRaw<
          { className: string; sectionName: string; lastMarked: Date | null }[]
        >(Prisma.sql`
          SELECT cg."name" AS "className", s."name" AS "sectionName",
                 (SELECT MAX(a."date") FROM "Attendance" a
                    JOIN "SectionSubject" ss ON ss."id" = a."sectionSubjectId"
                   WHERE ss."sectionId" = s."id" AND a."schoolId" = ${schoolId}
                     AND a."date" <= ${today}) AS "lastMarked"
            FROM "Section" s
            JOIN "ClassGrade" cg ON cg."id" = s."classGradeId"
           WHERE s."schoolId" = ${schoolId} AND s."isActive"
             AND EXISTS (SELECT 1 FROM "Enrollment" e
                           JOIN "StudentProfile" sp ON sp."id" = e."studentId" AND sp."isActive"
                           LEFT JOIN "User" u       ON u."id" = sp."userId"
                          WHERE e."sectionId" = s."id" AND e."academicYearId" = ${academicYearId}
                            AND e."status" = 'ACTIVE' AND (u."id" IS NULL OR u."isActive"))
           ORDER BY cg."level" NULLS LAST, cg."name", s."name"`),
    );
  }

  /** Empty or missing means the app default (Monday to Saturday). */
  async workingDays(schoolId: string): Promise<string[]> {
    const config = await this.prisma.timetableConfig.findUnique({
      where: { schoolId },
      select: { workingDays: true },
    });
    return config?.workingDays ?? [];
  }

  /**
   * Q7a: finalized exam results by section. Both filters matter: a reopened examination keeps
   * its result rows but nulls finalizedAt (exam-results.service reopen).
   */
  examResults(schoolId: string, academicYearId: string) {
    return this.cached(
      schoolId,
      'exam-results',
      { ay: academicYearId },
      60,
      () =>
        this.prisma.$queryRaw<
          {
            sectionName: string;
            className: string;
            level: number | null;
            results: number;
            obtained: number;
            max: number;
            passed: number;
            decided: number;
          }[]
        >(Prisma.sql`
        SELECT s."name" AS "sectionName", cg."name" AS "className", cg."level",
               COUNT(*)::int                                        AS results,
               SUM(er."totalObtained")::int                         AS obtained,
               SUM(er."totalMax")::int                              AS max,
               COUNT(*) FILTER (WHERE er."passed")::int             AS passed,
               COUNT(*) FILTER (WHERE er."passed" IS NOT NULL)::int AS decided
          FROM "Examination" x
          JOIN "ExaminationResult" er ON er."examinationId" = x."id"
          JOIN "Section" s            ON s."id" = x."sectionId"
          JOIN "ClassGrade" cg        ON cg."id" = x."classGradeId"
         WHERE x."schoolId" = ${schoolId} AND x."academicYearId" = ${academicYearId}
           AND x."status" = 'PUBLISHED' AND x."resultStatus" = 'FINALIZED'
           AND er."finalizedAt" IS NOT NULL AND er."totalMax" > 0
         GROUP BY s."id", s."name", cg."name", cg."level"`),
    );
  }

  /** Finalized results per term of the session, in term order. Exams without a term are left out. */
  examResultsByTerm(schoolId: string, academicYearId: string) {
    return this.cached(schoolId, 'exam-terms', { ay: academicYearId }, 60, () =>
      this.prisma.$queryRaw<
        {
          name: string;
          obtained: number;
          max: number;
          passed: number;
          decided: number;
        }[]
      >(Prisma.sql`
        SELECT t."name",
               SUM(er."totalObtained")::int                         AS obtained,
               SUM(er."totalMax")::int                              AS max,
               COUNT(*) FILTER (WHERE er."passed")::int             AS passed,
               COUNT(*) FILTER (WHERE er."passed" IS NOT NULL)::int AS decided
          FROM "Examination" x
          JOIN "AcademicTerm" t       ON t."id" = x."termId"
          JOIN "ExaminationResult" er ON er."examinationId" = x."id"
         WHERE x."schoolId" = ${schoolId} AND x."academicYearId" = ${academicYearId}
           AND x."status" = 'PUBLISHED' AND x."resultStatus" = 'FINALIZED'
           AND er."finalizedAt" IS NOT NULL AND er."totalMax" > 0
         GROUP BY t."id", t."sortOrder", t."name"
         ORDER BY t."sortOrder", t."name"`),
    );
  }

  /**
   * Marks per subject over the session's finalized exams, keyed by the subject's name so
   * branches can be compared. Absent and unmarked papers are left out.
   */
  subjectScores(schoolId: string, academicYearId: string) {
    return this.cached(
      schoolId,
      'exam-subjects',
      { ay: academicYearId },
      60,
      () =>
        this.prisma.$queryRaw<
          {
            key: string;
            name: string;
            obtained: number;
            max: number;
            marks: number;
          }[]
        >(Prisma.sql`
        SELECT lower(trim(sub."name")) AS key, MIN(trim(sub."name")) AS name,
               SUM(r."score")::int AS obtained, SUM(e."maxScore")::int AS max,
               COUNT(*)::int AS marks
          FROM "ExamResult" r
          JOIN "Exam" e            ON e."id" = r."examId"
          JOIN "Examination" x     ON x."id" = e."examinationId"
          JOIN "SectionSubject" ss ON ss."id" = e."sectionSubjectId"
          JOIN "Subject" sub       ON sub."id" = ss."subjectId"
         WHERE x."schoolId" = ${schoolId} AND x."academicYearId" = ${academicYearId}
           AND x."status" = 'PUBLISHED' AND x."resultStatus" = 'FINALIZED'
           AND NOT r."isAbsent" AND r."score" IS NOT NULL AND e."maxScore" > 0
         GROUP BY lower(trim(sub."name"))`),
    );
  }

  /** Q7c: date sheets waiting for the principal's review, across every session (it is a queue). */
  examBacklog(schoolId: string) {
    return this.cached(schoolId, 'exam-backlog', {}, 60, async () => {
      const agg = await this.prisma.examination.aggregate({
        where: { schoolId, status: 'PENDING_REVIEW' },
        _count: { _all: true },
        _min: { submittedAt: true },
      });
      return {
        pending: agg._count._all,
        oldestSubmittedAt: agg._min.submittedAt?.toISOString() ?? null,
      };
    });
  }

  /** Q7d: published examinations whose last paper was held before the cutoff but are not finalized. */
  unfinalizedExams(schoolId: string, academicYearId: string, cutoff: Date) {
    return this.cached(
      schoolId,
      'exam-unfinalized',
      { ay: academicYearId, cutoff: cutoff.toISOString().slice(0, 10) },
      60,
      async () => {
        const [row] = await this.prisma.$queryRaw<{ exams: number }[]>`
          SELECT COUNT(*)::int AS exams
            FROM (SELECT x."id"
                    FROM "Examination" x
                    JOIN "Exam" e ON e."examinationId" = x."id"
                   WHERE x."schoolId" = ${schoolId} AND x."academicYearId" = ${academicYearId}
                     AND x."status" = 'PUBLISHED' AND x."resultStatus" <> 'FINALIZED'
                   GROUP BY x."id"
                  HAVING MAX(e."heldAt") < ${cutoff}) t`;
        return row.exams;
      },
    );
  }

  /**
   * Q1t + QS2: active teachers (both the profile and the login active), and how well the
   * sections that have students this session are covered by them.
   */
  staffing(schoolId: string, academicYearId: string | null) {
    return this.cached(
      schoolId,
      'q1-staffing',
      { ay: academicYearId },
      60,
      async () => {
        const [row] = await this.prisma.$queryRaw<
          {
            teachers: number;
            offerings: number;
            uncovered: number;
            sections: number;
            noClassTeacher: number;
          }[]
        >`
        WITH active_t AS (
          SELECT tp."id" FROM "TeacherProfile" tp
            JOIN "User" u ON u."id" = tp."userId"
           WHERE tp."schoolId" = ${schoolId} AND tp."isActive" AND u."isActive"
        ), sec AS (
          SELECT s."id" FROM "Section" s
           WHERE s."schoolId" = ${schoolId} AND s."isActive"
             AND EXISTS (SELECT 1 FROM "Enrollment" e
                           JOIN "StudentProfile" sp ON sp."id" = e."studentId" AND sp."isActive"
                           LEFT JOIN "User" u       ON u."id" = sp."userId"
                          WHERE e."sectionId" = s."id" AND e."academicYearId" = ${academicYearId}
                            AND e."status" = 'ACTIVE' AND (u."id" IS NULL OR u."isActive"))
        )
        SELECT (SELECT COUNT(*) FROM active_t)::int AS teachers,
               (SELECT COUNT(*) FROM "SectionSubject" ss JOIN sec ON sec."id" = ss."sectionId")::int AS offerings,
               (SELECT COUNT(*) FROM "SectionSubject" ss JOIN sec ON sec."id" = ss."sectionId"
                 WHERE ss."teacherId" IS NULL
                    OR ss."teacherId" NOT IN (SELECT "id" FROM active_t))::int AS uncovered,
               (SELECT COUNT(*) FROM sec)::int AS sections,
               (SELECT COUNT(*) FROM sec
                 WHERE NOT EXISTS (SELECT 1 FROM "SectionTeacher" st
                                    WHERE st."sectionId" = sec."id" AND st."isPrimary"
                                      AND st."teacherId" IN (SELECT "id" FROM active_t)))::int AS "noClassTeacher"`;
        return row;
      },
    );
  }

  /** Q9a: active users of each role, and how many of them signed in during the window. */
  adoption(schoolId: string, range: RangeWindow) {
    const { from, to } = range.window;
    return this.cached(
      schoolId,
      'q9-adoption',
      { from, to },
      rangeTtl(range.days),
      () =>
        this.prisma.$queryRaw<
          { role: string; active: number; signedIn: number }[]
        >`
          WITH logins AS (
            SELECT DISTINCT l."actorUserId"
              FROM "AuditLog" l
             WHERE l."schoolId" = ${schoolId} AND l."action" = 'LOGIN'
               AND l."createdAt" >= ${range.start} AND l."createdAt" < ${range.endExclusive}
          )
          SELECT u."role"::text AS role, COUNT(*)::int AS active,
                 COUNT(lg."actorUserId")::int AS "signedIn"
            FROM "User" u
            LEFT JOIN logins lg ON lg."actorUserId" = u."id"
           WHERE u."schoolId" = ${schoolId} AND u."isActive"
             AND u."role" IN ('TEACHER', 'PARENT', 'STUDENT')
           GROUP BY u."role"`,
    );
  }

  /**
   * Active parents who did anything in the window: signed in, sent a message or uploaded a fee
   * receipt. A sign-in alone undercounts parents who stay signed in on the app.
   */
  parentEngagement(schoolId: string, range: RangeWindow) {
    const { from, to } = range.window;
    return this.cached(
      schoolId,
      'q9-engagement',
      { from, to },
      rangeTtl(range.days),
      async () => {
        const [row] = await this.prisma.$queryRaw<
          { active: number; engaged: number }[]
        >`
          WITH parents AS (
            SELECT "id" FROM "User"
             WHERE "schoolId" = ${schoolId} AND "role" = 'PARENT' AND "isActive"
          ), engaged AS (
            SELECT l."actorUserId" AS id FROM "AuditLog" l
             WHERE l."schoolId" = ${schoolId} AND l."action" = 'LOGIN'
               AND l."createdAt" >= ${range.start} AND l."createdAt" < ${range.endExclusive}
            UNION
            SELECT m."senderId" FROM "Message" m JOIN parents p ON p."id" = m."senderId"
             WHERE m."createdAt" >= ${range.start} AND m."createdAt" < ${range.endExclusive}
            UNION
            SELECT s."submittedByUserId" FROM "PaymentSubmission" s
             WHERE s."schoolId" = ${schoolId}
               AND s."createdAt" >= ${range.start} AND s."createdAt" < ${range.endExclusive}
          )
          SELECT (SELECT COUNT(*)::int FROM parents) AS active,
                 (SELECT COUNT(*)::int FROM parents p JOIN engaged e ON e.id = p."id") AS engaged`;
        return row;
      },
    );
  }

  /**
   * Fee pace: of a billing month's live challans, how much had been paid by `cutoff`.
   * Comparing this month at today with last month at the same day shows a slowdown early.
   */
  collectionPace(schoolId: string, year: number, month: number, cutoff: Date) {
    return this.cached(
      schoolId,
      'q2-pace',
      { y: year, m: month, cutoff: cutoff.toISOString().slice(0, 10) },
      60,
      async () => {
        const [row] = await this.prisma.$queryRaw<
          { billed: bigint | null; paid: bigint | null }[]
        >`
          SELECT (SELECT SUM(c."netAmount") FROM "Challan" c
                   WHERE c."schoolId" = ${schoolId} AND c."periodYear" = ${year}
                     AND c."periodMonth" = ${month} AND c."status" <> 'CANCELLED')::bigint AS billed,
                 (SELECT SUM(p."amount") FROM "Payment" p
                    JOIN "Challan" c ON c."id" = p."challanId"
                   WHERE c."schoolId" = ${schoolId} AND c."periodYear" = ${year}
                     AND c."periodMonth" = ${month} AND c."status" <> 'CANCELLED'
                     AND p."voidedAt" IS NULL AND p."paidAt" < ${cutoff})::bigint AS paid`;
        return { billed: Number(row.billed ?? 0), paid: Number(row.paid ?? 0) };
      },
    );
  }

  /** This month at today against last month at the same day of the month. */
  async pace(schoolId: string, now: Date) {
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
      this.collectionPace(schoolId, y, m + 1, cutoff(y, m)),
      this.collectionPace(
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

  /**
   * Students with 2+ overdue challans this session: the ones heading for default. Overdue is
   * fee-calculator's isOverdue: not paid or cancelled, and due before today.
   */
  defaulters(schoolId: string, academicYearId: string, today: Date) {
    const day = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    return this.cached(
      schoolId,
      'q2-defaulters',
      { ay: academicYearId, day: day.toISOString().slice(0, 10) },
      60,
      async () => {
        const [row] = await this.prisma.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM (
            SELECT "studentId" FROM "Challan"
             WHERE "schoolId" = ${schoolId} AND "academicYearId" = ${academicYearId}
               AND "status" IN ('UNPAID', 'PARTIALLY_PAID') AND "dueDate" < ${day}
             GROUP BY "studentId" HAVING COUNT(*) >= 2) late`;
        return row.n;
      },
    );
  }

  /**
   * Users of a role who left in the window: deactivated or deleted. Only the audit log keeps the
   * date (users.service setActive/remove), so history starts when those audits did (2026-10-01).
   */
  leavers(schoolId: string, role: 'TEACHER' | 'STUDENT', range: RangeWindow) {
    const { from, to } = range.window;
    return this.cached(
      schoolId,
      'q-leavers',
      { role, from, to },
      rangeTtl(range.days),
      async () => {
        const [row] = await this.prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(DISTINCT "entityId")::int AS n FROM "AuditLog"
         WHERE "schoolId" = ${schoolId}
           AND "action" IN ('USER_DEACTIVATE', 'USER_DELETE')
           AND "metadata"->>'role' = ${role}
           AND "createdAt" >= ${range.start} AND "createdAt" < ${range.endExclusive}`;
        return row.n;
      },
    );
  }

  /** Teacher accounts created in the window, the other half of turnover. */
  teacherJoiners(schoolId: string, range: RangeWindow) {
    const { from, to } = range.window;
    return this.cached(
      schoolId,
      'q-joiners',
      { from, to },
      rangeTtl(range.days),
      () =>
        this.prisma.user.count({
          where: {
            schoolId,
            role: 'TEACHER',
            createdAt: { gte: range.start, lt: range.endExclusive },
          },
        }),
    );
  }
}
