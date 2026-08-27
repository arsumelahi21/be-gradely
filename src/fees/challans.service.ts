import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { CacheService } from '../common/services/cache.service';
import { AuditLogService } from '../audit/audit.service';
import {
  NOTIFICATION_CREATE_BATCH,
  type NotificationCreateBatchEvent,
} from '../common/events/notification.events';
import {
  parentUserIdsByStudent,
  studentUserIdByStudent,
} from '../common/notifications/recipients';
import { formatMinorUnits } from './money.util';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import {
  computeChallan,
  formatChallanNo,
  isOverdue,
  remainingBalance,
  resolveChallanStatus,
  type ComputedChallan,
  type DiscountInput,
  type FeeHeadOverrideInput,
} from './fee-calculator';
import {
  ChallanGenerationType,
  ChallanItemKind,
  ChallanStatus,
  DiscountType,
} from './fees.types';

import { InstallmentPlansService } from './installment-plans.service';
import { GenerateChallansDto } from './dto/generate-challans.dto';
import { CreateChallanDto } from './dto/create-challan.dto';
import {
  ChallanCoverageQueryDto,
  ChallanQueryDto,
  SectionInstallmentQueryDto,
  StudentFeeStatusDto,
} from './dto/challan-query.dto';
import { feesCachePrefix } from './fees-cache';

/** Plain-English skip reasons for the preview's "will be skipped" list. */
const SKIP_MESSAGES: Record<string, string> = {
  NO_PLAN: 'This student is not on an installment plan for that academic year.',
  NO_SUCH_INSTALLMENT: 'Their plan has no installment with that number.',
  ALREADY_GENERATED:
    'A challan for this installment has already been generated.',
  PERIOD_TAKEN:
    'This student already has a challan for the month this installment falls due.',
};

const SKIP_LABELS: Record<string, string> = {
  NO_PLAN: 'no installment plan',
  NO_SUCH_INSTALLMENT: 'plan has no such installment',
  ALREADY_GENERATED: 'already generated',
  PERIOD_TAKEN: 'already billed for that month',
};

/** A whole class prints in one go; a whole year does not. */
const PRINT_BATCH_LIMIT = 400;

/** Retries absorb a genuine concurrent-generation race (P2002). */
const MAX_GENERATE_ATTEMPTS = 3;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

type RosterStudent = {
  id: string;
  fullName: string;
  rollNo: string | null;
  /** The section this student is enrolled in — a class run spans several. */
  sectionId: string;
  monthlyFeeAmount: number;
  discount: DiscountInput | null;
};

type BillingPlan = {
  schoolId: string;
  currency: string;
  section: {
    id: string;
    name: string;
    classGradeId: string;
    className: string;
  };
  /** Every section in the run, by id — each challan snapshots its own. */
  sectionById: Record<
    string,
    { id: string; name: string; classGradeId: string; className: string }
  >;
  issueDate: Date;
  dueDate: Date;
  bankAccountId: string | null;
  challanPrefix: string | null;
  toGenerate: {
    student: RosterStudent;
    computed: ComputedChallan;
    /** Earlier unpaid challans folded into this one, and superseded by it. */
    arrears: ArrearsCarryForward | null;
  }[];
  alreadyBilled: {
    studentId: string;
    fullName: string;
    rollNo: string | null;
    challanNo: string;
  }[];
  /** Billed by installment instead, so the monthly challan is not theirs. */
  skippedOnPlan: {
    studentId: string;
    fullName: string;
    rollNo: string | null;
    reason: string;
  }[];
};

type ArrearsCarryForward = {
  amount: number;
  supersede: { id: string; challanNo: string }[];
  periods: string[];
};

/**
 * The arrears line's wording. Names the periods when there are few, and falls
 * back to a count so a long-overdue student doesn't get an unreadable label.
 */
function arrearsFor(
  carry: ArrearsCarryForward | undefined,
): { amount: number; label: string } | null {
  if (!carry || carry.amount <= 0) return null;
  const label =
    carry.periods.length <= 2
      ? `Arrears (${carry.periods.join(', ')})`
      : `Arrears (${carry.periods.length} previous challans)`;
  return { amount: carry.amount, label };
}

/** UTC midnight — matches the `@db.Date` columns so "overdue" can't flip on the viewer's clock. */
const utcDate = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));
const utcMidnight = (value: string | Date) => {
  const d = new Date(value);
  return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};
const todayUtc = () => utcMidnight(new Date());

@Injectable()
export class ChallansService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly installmentPlans: InstallmentPlansService,
  ) {
    super(prisma, cache);
  }

  // ==== Generation =========================================================

  /** Dry run: who gets billed, who is already billed, and the totals. */
  async preview(dto: GenerateChallansDto, actor: Actor) {
    if (dto.generationType === ChallanGenerationType.INSTALLMENT) {
      return this.describeInstallmentPlan(
        await this.buildInstallmentBatch(dto, actor),
      );
    }
    const plan = await this.buildPlan(dto, actor);
    return this.describePlan(plan);
  }

  async generate(dto: GenerateChallansDto, actor: Actor) {
    if (dto.generationType === ChallanGenerationType.INSTALLMENT) {
      return this.generateInstallments(dto, actor);
    }
    return this.runGeneration(dto, actor);
  }

  /** Single student — the same path with a roster of one. */
  async createSingle(dto: CreateChallanDto, actor: Actor) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: dto.studentId },
      select: { id: true, schoolId: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    this.enforceScope(actor, student.schoolId);

    // Resolve the student's section from their ACTIVE enrollment for the year.
    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        studentId: dto.studentId,
        academicYearId: dto.academicYearId,
        status: 'ACTIVE',
      },
      select: { sectionId: true },
    });
    if (!enrollment) {
      throw new BadRequestException(
        'Student has no active enrollment for this academic year, so there is no class to bill them under.',
      );
    }

    // An installment student is billed one plan row, not a month — the same
    // batch path with a roster of one, so the duplicate guard and the skip
    // reasons are identical to the section flow.
    if (dto.generationType === ChallanGenerationType.INSTALLMENT) {
      const result = await this.generateInstallments(
        { ...dto, sectionId: enrollment.sectionId },
        actor,
        dto.studentId,
      );
      if (!result.generated) {
        const reason = result.skippedDetail?.[0]?.reason;
        throw new BadRequestException(
          SKIP_MESSAGES[reason ?? ''] ??
            'This installment cannot be billed right now.',
        );
      }
      return result;
    }

    const result = await this.runGeneration(
      { ...dto, sectionId: enrollment.sectionId },
      actor,
      dto.studentId,
    );
    if (!result.generated && result.skipped) {
      throw new BadRequestException(
        result.skippedOnPlan.length
          ? 'This student is on an installment plan, so they are billed by installment rather than by month. Use Generate Installment Challan instead.'
          : 'This student already has a challan for that month.',
      );
    }
    return result;
  }

  /**
   * Which sections a run covers: one, or every active section of a class.
   *
   * A class-wide run is ONE batch, not a loop over sections — the roster and
   * every lookup below it stay a constant number of queries however many
   * sections a class has.
   */
  private async resolveTargetSections(
    dto: GenerateChallansDto,
    schoolId: string,
  ) {
    const select = {
      id: true,
      name: true,
      schoolId: true,
      classGradeId: true,
      classGrade: { select: { name: true } },
    };

    if (dto.sectionId) {
      const section = await this.prisma.section.findUnique({
        where: { id: dto.sectionId },
        select,
      });
      if (!section) throw new NotFoundException('Section not found');
      if (section.schoolId !== schoolId) {
        throw new ForbiddenException('Cross-school access denied');
      }
      return [section];
    }

    if (!dto.classGradeId) {
      throw new BadRequestException(
        'Choose a section, or a class to bill every section at once.',
      );
    }

    const sections = await this.prisma.section.findMany({
      where: { classGradeId: dto.classGradeId, schoolId },
      orderBy: { name: 'asc' },
      select,
    });
    if (!sections.length) {
      throw new BadRequestException(
        'This class has no sections to bill. Add a section first.',
      );
    }
    return sections;
  }

  private async runGeneration(
    dto: GenerateChallansDto,
    actor: Actor,
    onlyStudentId?: string,
  ) {
    let lastPlan: BillingPlan | null = null;

    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt++) {
      // Rebuilt each attempt so a retry sees the winner's rows and reports
      // them as skipped rather than failing.
      const plan = await this.buildPlan(dto, actor, onlyStudentId);
      lastPlan = plan;

      if (!plan.toGenerate.length) {
        return {
          generated: 0,
          skipped: plan.alreadyBilled.length + plan.skippedOnPlan.length,
          failed: 0,
          challanIds: [] as string[],
          alreadyBilled: plan.alreadyBilled,
          skippedOnPlan: plan.skippedOnPlan,
        };
      }

      try {
        const challanIds = await this.prisma.$transaction(async (tx) => {
          // Challans are never hard-deleted (cancel only), so count is a
          // monotonic per-school sequence source.
          const existingCount = await tx.challan.count({
            where: { schoolId: plan.schoolId },
          });
          const ids: string[] = [];

          for (const [i, row] of plan.toGenerate.entries()) {
            const { student, computed } = row;
            const created = await tx.challan.create({
              data: {
                schoolId: plan.schoolId,
                challanNo: formatChallanNo(
                  plan.challanPrefix,
                  existingCount + i + 1,
                ),
                studentId: student.id,
                academicYearId: dto.academicYearId,
                periodYear: dto.periodYear,
                periodMonth: dto.periodMonth,
                // The STUDENT's section, not the batch's — a class-wide run
                // spans several and each challan must name its own.
                classGradeId: plan.sectionById[student.sectionId].classGradeId,
                sectionId: student.sectionId,
                className: plan.sectionById[student.sectionId].className,
                sectionName: plan.sectionById[student.sectionId].name,
                issueDate: plan.issueDate,
                dueDate: plan.dueDate,
                grossAmount: computed.grossAmount,
                discountAmount: computed.discountAmount,
                netAmount: computed.netAmount,
                paidAmount: 0,
                // A zero-total challan has nothing to collect.
                status: resolveChallanStatus(0, computed.netAmount),
                bankAccountId: plan.bankAccountId,
                generatedByUserId: actor.userId,
                items: {
                  create: computed.items.map((item) => ({
                    feeHeadId: item.feeHeadId,
                    label: item.label,
                    amount: item.amount,
                    kind: item.kind,
                    sortOrder: item.sortOrder,
                  })),
                },
              },
              select: { id: true, challanNo: true },
            });
            ids.push(created.id);

            // Supersede the challans just folded in — IN THE SAME TRANSACTION.
            // If this failed after the insert, the student would be billed for
            // the same arrears twice, on two live challans.
            const superseded = row.arrears?.supersede ?? [];
            if (superseded.length) {
              await tx.challan.updateMany({
                where: {
                  id: { in: superseded.map((c) => c.id) },
                  // Re-assert the precondition: only a still-unpaid, unpaid-in-
                  // full challan may be cancelled this way.
                  status: ChallanStatus.UNPAID,
                  paidAmount: 0,
                },
                data: {
                  status: ChallanStatus.CANCELLED,
                  cancelledAt: new Date(),
                  cancelReason: `Carried forward to ${created.challanNo}`,
                },
              });
            }
          }
          return ids;
        });

        await this.invalidateFeeCache(plan.schoolId);
        await this.audit.record(actor.userId, 'FEE_CHALLAN_GENERATE', {
          schoolId: plan.schoolId,
          entityType: 'Challan',
          metadata: {
            sectionId: plan.section.id,
            periodYear: dto.periodYear,
            periodMonth: dto.periodMonth,
            generated: challanIds.length,
            skipped: plan.alreadyBilled.length,
          },
        });

        // challanIds are returned in plan.toGenerate order, so each student is
        // paired with the challan actually written for them.
        await this.notifyChallansIssued(
          plan.toGenerate.map(({ student, computed }, i) => ({
            studentId: student.id,
            fullName: student.fullName,
            challanId: challanIds[i],
            netAmount: computed.netAmount,
          })),
          dto.periodYear,
          dto.periodMonth,
          plan.dueDate,
          plan.currency,
        );

        return {
          generated: challanIds.length,
          skipped: plan.alreadyBilled.length + plan.skippedOnPlan.length,
          failed: 0,
          challanIds,
          alreadyBilled: plan.alreadyBilled,
          skippedOnPlan: plan.skippedOnPlan,
        };
      } catch (e) {
        const isDuplicate =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002';
        if (!isDuplicate || attempt === MAX_GENERATE_ATTEMPTS) throw e;
        // Lost a race — loop and rebuild the plan.
      }
    }

    return {
      generated: 0,
      skipped:
        (lastPlan?.alreadyBilled.length ?? 0) +
        (lastPlan?.skippedOnPlan.length ?? 0),
      failed: 0,
      challanIds: [] as string[],
      alreadyBilled: lastPlan?.alreadyBilled ?? [],
      skippedOnPlan: lastPlan?.skippedOnPlan ?? [],
    };
  }

  /**
   * All reads for a batch happen here in a CONSTANT number of queries — the
   * N+1 trap in this module is loading heads/discounts per student.
   */
  private async buildPlan(
    dto: GenerateChallansDto,
    actor: Actor,
    onlyStudentId?: string,
  ): Promise<BillingPlan> {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);

    const [school, sections, academicYear] = await Promise.all([
      this.prisma.school.findUnique({
        where: { id: schoolId },
        select: {
          currency: true,
          feeChallanPrefix: true,
          feeDueDayOfMonth: true,
        },
      }),
      this.resolveTargetSections(dto, schoolId),
      this.prisma.academicYear.findUnique({
        where: { id: dto.academicYearId },
        select: { id: true, schoolId: true },
      }),
    ]);

    if (!school) throw new NotFoundException('School not found');
    if (!academicYear) throw new NotFoundException('Academic year not found');
    if (academicYear.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
    // The first section stands for the batch in the response header; each
    // challan still carries its OWN section snapshot.
    const section = sections[0];

    const [enrollments, feeHeads] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: {
          sectionId: { in: sections.map((sec) => sec.id) },
          academicYearId: dto.academicYearId,
          status: 'ACTIVE',
          ...(onlyStudentId ? { studentId: onlyStudentId } : {}),
        },
        select: {
          sectionId: true,
          student: {
            select: {
              id: true,
              fullName: true,
              rollNo: true,
              schoolId: true,
              monthlyFeeAmount: true,
              discount: {
                select: {
                  id: true,
                  name: true,
                  type: true,
                  value: true,
                  isActive: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.feeHead.findMany({
        where: { schoolId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, defaultAmount: true },
      }),
    ]);

    const enrolled = enrollments
      // Defence in depth: an enrollment must never bill another tenant's student.
      .filter((e) => e.student.schoolId === schoolId)
      .map((e) => ({
        id: e.student.id,
        fullName: e.student.fullName,
        rollNo: e.student.rollNo,
        // Each student's OWN section, so a class-wide run snapshots the right
        // one onto every challan rather than the batch's first.
        sectionId: e.sectionId,
        monthlyFeeAmount: e.student.monthlyFeeAmount,
        // An inactive discount stops applying to NEW challans.
        discount:
          e.student.discount && e.student.discount.isActive
            ? {
                id: e.student.discount.id,
                name: e.student.discount.name,
                type: e.student.discount.type as DiscountType,
                value: e.student.discount.value,
              }
            : null,
      }));

    /**
     * A student on an active plan is billed by installment, never by month —
     * billing both would charge them twice for the same year. Enforced HERE
     * rather than in the UI, so the rule holds for any caller.
     *
     * One bulk query for the whole roster.
     */
    const onPlan = enrolled.length
      ? new Set(
          (
            await this.prisma.feeInstallmentPlan.findMany({
              where: {
                studentId: { in: enrolled.map((s) => s.id) },
                academicYearId: dto.academicYearId,
                isActive: true,
              },
              select: { studentId: true },
            })
          ).map((p) => p.studentId),
        )
      : new Set<string>();

    const roster: RosterStudent[] = enrolled.filter((s) => !onPlan.has(s.id));
    const skippedOnPlan = enrolled
      .filter((s) => onPlan.has(s.id))
      .map((s) => ({
        studentId: s.id,
        fullName: s.fullName,
        rollNo: s.rollNo,
        reason: 'ON_INSTALLMENT_PLAN',
      }));

    // One query for the whole roster's overrides — per-student loading here is
    // the N+1 this module has to avoid.
    const overrideRows = roster.length
      ? await this.prisma.studentFeeHeadOverride.findMany({
          where: { studentId: { in: roster.map((s) => s.id) } },
          select: {
            studentId: true,
            feeHeadId: true,
            amount: true,
            isExcluded: true,
          },
        })
      : [];
    const overridesByStudent = new Map<string, FeeHeadOverrideInput[]>();
    for (const row of overrideRows) {
      const list = overridesByStudent.get(row.studentId) ?? [];
      list.push({
        feeHeadId: row.feeHeadId,
        amount: row.amount,
        isExcluded: row.isExcluded,
      });
      overridesByStudent.set(row.studentId, list);
    }

    const existing = roster.length
      ? await this.prisma.challan.findMany({
          where: {
            studentId: { in: roster.map((s) => s.id) },
            academicYearId: dto.academicYearId,
            periodYear: dto.periodYear,
            periodMonth: dto.periodMonth,
          },
          select: { studentId: true, challanNo: true },
        })
      : [];
    const billedIds = new Map(existing.map((c) => [c.studentId, c.challanNo]));

    /**
     * Unpaid balance from EARLIER periods, carried onto this challan.
     *
     * Only challans with NO recorded payment are eligible. Superseding one
     * cancels it, and `studentFeeHistory` excludes cancelled challans from
     * `totalPaid` — so cancelling a part-paid challan would erase money the
     * school actually received. A part-paid challan is therefore left open and
     * payable on its own.
     *
     * One query for the whole roster.
     */
    const arrearsRows = roster.length
      ? await this.prisma.challan.findMany({
          where: {
            studentId: { in: roster.map((s) => s.id) },
            academicYearId: dto.academicYearId,
            status: ChallanStatus.UNPAID,
            paidAmount: 0,
            // Strictly EARLIER than the period being billed.
            OR: [
              { periodYear: { lt: dto.periodYear } },
              {
                periodYear: dto.periodYear,
                periodMonth: { lt: dto.periodMonth },
              },
            ],
          },
          orderBy: [{ periodYear: 'asc' }, { periodMonth: 'asc' }],
          select: {
            id: true,
            studentId: true,
            challanNo: true,
            netAmount: true,
            paidAmount: true,
            periodYear: true,
            periodMonth: true,
          },
        })
      : [];

    const arrearsByStudent = new Map<
      string,
      {
        amount: number;
        supersede: { id: string; challanNo: string }[];
        periods: string[];
      }
    >();
    for (const row of arrearsRows) {
      const balance = remainingBalance(row.netAmount, row.paidAmount);
      if (balance <= 0) continue;
      const entry = arrearsByStudent.get(row.studentId) ?? {
        amount: 0,
        supersede: [],
        periods: [],
      };
      entry.amount += balance;
      entry.supersede.push({ id: row.id, challanNo: row.challanNo });
      entry.periods.push(
        `${MONTH_NAMES[row.periodMonth - 1]} ${row.periodYear}`,
      );
      arrearsByStudent.set(row.studentId, entry);
    }

    const bankAccountId = await this.resolveBankAccount(
      schoolId,
      dto.bankAccountId,
    );

    const issueDate = dto.issueDate ? utcMidnight(dto.issueDate) : todayUtc();
    const dueDate = dto.dueDate
      ? utcMidnight(dto.dueDate)
      : utcDate(
          dto.periodYear,
          dto.periodMonth,
          Math.min(school.feeDueDayOfMonth, 28),
        );

    return {
      schoolId,
      currency: school.currency,
      challanPrefix: school.feeChallanPrefix,
      section: {
        id: section.id,
        name: section.name,
        classGradeId: section.classGradeId,
        className: section.classGrade.name,
      },
      sectionById: Object.fromEntries(
        sections.map((sec) => [
          sec.id,
          {
            id: sec.id,
            name: sec.name,
            classGradeId: sec.classGradeId,
            className: sec.classGrade.name,
          },
        ]),
      ),
      issueDate,
      dueDate,
      bankAccountId,
      toGenerate: roster
        .filter((s) => !billedIds.has(s.id))
        .map((student) => ({
          student,
          computed: computeChallan({
            monthlyFeeAmount: student.monthlyFeeAmount,
            feeHeads,
            // Per-student heads. The resulting amounts are copied onto
            // ChallanItem, so a later override edit can't rewrite this bill.
            overrides: overridesByStudent.get(student.id) ?? null,
            discount: student.discount,
            arrears: arrearsFor(arrearsByStudent.get(student.id)),
          }),
          arrears: arrearsByStudent.get(student.id) ?? null,
        })),
      alreadyBilled: roster
        .filter((s) => billedIds.has(s.id))
        .map((s) => ({
          studentId: s.id,
          fullName: s.fullName,
          rollNo: s.rollNo,
          challanNo: billedIds.get(s.id)!,
        })),
      skippedOnPlan,
    };
  }

  private describePlan(plan: BillingPlan) {
    const totals = plan.toGenerate.reduce(
      (acc, { computed }) => ({
        grossAmount: acc.grossAmount + computed.grossAmount,
        discountAmount: acc.discountAmount + computed.discountAmount,
        netAmount: acc.netAmount + computed.netAmount,
      }),
      { grossAmount: 0, discountAmount: 0, netAmount: 0 },
    );

    return {
      currency: plan.currency,
      section: plan.section,
      issueDate: plan.issueDate,
      dueDate: plan.dueDate,
      bankAccountId: plan.bankAccountId,
      willGenerate: plan.toGenerate.map(({ student, computed, arrears }) => ({
        studentId: student.id,
        fullName: student.fullName,
        rollNo: student.rollNo,
        discountName: student.discount?.name ?? null,
        grossAmount: computed.grossAmount,
        discountAmount: computed.discountAmount,
        netAmount: computed.netAmount,
        // Shown before generating, because superseding earlier challans is not
        // something an admin should discover afterwards.
        arrearsAmount: arrears?.amount ?? 0,
        supersedes: arrears?.supersede.map((c) => c.challanNo) ?? [],
        items: computed.items,
      })),
      alreadyBilled: plan.alreadyBilled,
      // Reported separately from "already billed": these students are not
      // behind, they are simply billed by installment instead.
      skippedOnPlan: plan.skippedOnPlan,
      counts: {
        willGenerate: plan.toGenerate.length,
        alreadyBilled: plan.alreadyBilled.length,
        onInstallmentPlan: plan.skippedOnPlan.length,
        total:
          plan.toGenerate.length +
          plan.alreadyBilled.length +
          plan.skippedOnPlan.length,
      },
      totals: {
        ...totals,
        arrearsAmount: plan.toGenerate.reduce(
          (sum, r) => sum + (r.arrears?.amount ?? 0),
          0,
        ),
      },
    };
  }

  private async resolveBankAccount(schoolId: string, requested?: string) {
    if (requested) {
      const account = await this.prisma.bankAccount.findUnique({
        where: { id: requested },
        select: { id: true, schoolId: true },
      });
      if (!account || account.schoolId !== schoolId) {
        throw new BadRequestException('Invalid bank account for this school');
      }
      return account.id;
    }
    const fallback = await this.prisma.bankAccount.findFirst({
      where: { schoolId, isDefault: true, isActive: true },
      select: { id: true },
    });
    return fallback?.id ?? null;
  }

  /**
   * Resolve WHO gets an installment challan for a section, and why the rest
   * don't — in a constant number of queries.
   *
   * The skip reasons are returned rather than swallowed: "nothing generated" is
   * useless feedback, "6 already billed, 2 have no plan" is actionable.
   */
  private async buildInstallmentBatch(
    dto: GenerateChallansDto,
    actor: Actor,
    onlyStudentId?: string,
  ) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    const seq = dto.installmentSeq!;

    const [school, section, academicYear] = await Promise.all([
      this.prisma.school.findUnique({
        where: { id: schoolId },
        select: { currency: true, feeChallanPrefix: true },
      }),
      this.prisma.section.findUnique({
        where: { id: dto.sectionId },
        select: {
          id: true,
          name: true,
          schoolId: true,
          classGradeId: true,
          classGrade: { select: { name: true } },
        },
      }),
      this.prisma.academicYear.findUnique({
        where: { id: dto.academicYearId },
        select: { id: true, schoolId: true },
      }),
    ]);
    if (!school) throw new NotFoundException('School not found');
    if (!section) throw new NotFoundException('Section not found');
    if (!academicYear) throw new NotFoundException('Academic year not found');
    if (section.schoolId !== schoolId || academicYear.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }

    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        sectionId: dto.sectionId,
        academicYearId: dto.academicYearId,
        status: 'ACTIVE',
        ...(onlyStudentId ? { studentId: onlyStudentId } : {}),
      },
      select: {
        student: {
          select: { id: true, fullName: true, rollNo: true, schoolId: true },
        },
      },
    });
    const roster = enrollments
      .filter((e) => e.student.schoolId === schoolId)
      .map((e) => e.student);
    if (!roster.length) {
      return { schoolId, school, section, seq, toGenerate: [], skipped: [] };
    }

    const plans = await this.prisma.feeInstallmentPlan.findMany({
      where: {
        studentId: { in: roster.map((s) => s.id) },
        academicYearId: dto.academicYearId,
        isActive: true,
      },
      select: {
        id: true,
        studentId: true,
        installments: {
          orderBy: { seq: 'asc' },
          select: { id: true, seq: true, amount: true, dueDate: true },
        },
      },
    });
    const planByStudent = new Map(plans.map((p) => [p.studentId, p]));

    const installmentIds = plans.flatMap((p) =>
      p.installments.map((i) => i.id),
    );
    const [billedRows, periodRows] = await Promise.all([
      installmentIds.length
        ? this.prisma.challan.findMany({
            where: { installmentId: { in: installmentIds } },
            select: { installmentId: true, challanNo: true },
          })
        : Promise.resolve([]),
      // A challan already covering the derived period would collide with the
      // one-bill-per-student-per-period rule.
      this.prisma.challan.findMany({
        where: {
          studentId: { in: roster.map((s) => s.id) },
          academicYearId: dto.academicYearId,
        },
        select: {
          studentId: true,
          periodYear: true,
          periodMonth: true,
          challanNo: true,
        },
      }),
    ]);
    const billed = new Map<string, string>(
      billedRows.map(
        (c) => [c.installmentId!, c.challanNo] as [string, string],
      ),
    );
    const periodTaken = new Map<string, string>(
      periodRows.map(
        (c) =>
          [`${c.studentId}:${c.periodYear}-${c.periodMonth}`, c.challanNo] as [
            string,
            string,
          ],
      ),
    );

    const toGenerate: {
      student: { id: string; fullName: string; rollNo: string | null };
      planId: string;
      installment: { id: string; seq: number; amount: number; dueDate: Date };
      installmentCount: number;
      periodYear: number;
      periodMonth: number;
    }[] = [];
    const skipped: {
      studentId: string;
      fullName: string;
      rollNo: string | null;
      reason: string;
      challanNo?: string;
    }[] = [];

    for (const student of roster) {
      const plan = planByStudent.get(student.id);
      const base = {
        studentId: student.id,
        fullName: student.fullName,
        rollNo: student.rollNo,
      };
      if (!plan) {
        skipped.push({ ...base, reason: 'NO_PLAN' });
        continue;
      }
      const installment = plan.installments.find((i) => i.seq === seq);
      if (!installment) {
        skipped.push({ ...base, reason: 'NO_SUCH_INSTALLMENT' });
        continue;
      }
      const existing = billed.get(installment.id);
      if (existing) {
        skipped.push({
          ...base,
          reason: 'ALREADY_GENERATED',
          challanNo: existing,
        });
        continue;
      }
      // The period a plan row belongs to IS its due month — that is what makes
      // an installment challan interchangeable with the month's normal one.
      const periodYear = installment.dueDate.getUTCFullYear();
      const periodMonth = installment.dueDate.getUTCMonth() + 1;
      const clash = periodTaken.get(
        `${student.id}:${periodYear}-${periodMonth}`,
      );
      if (clash) {
        skipped.push({ ...base, reason: 'PERIOD_TAKEN', challanNo: clash });
        continue;
      }

      toGenerate.push({
        student,
        planId: plan.id,
        installment,
        installmentCount: plan.installments.length,
        periodYear,
        periodMonth,
      });
    }

    return { schoolId, school, section, seq, toGenerate, skipped };
  }

  private describeInstallmentPlan(
    batch: Awaited<ReturnType<ChallansService['buildInstallmentBatch']>>,
  ) {
    const netAmount = batch.toGenerate.reduce(
      (s, r) => s + r.installment.amount,
      0,
    );
    return {
      generationType: ChallanGenerationType.INSTALLMENT,
      installmentSeq: batch.seq,
      currency: batch.school.currency,
      section: {
        id: batch.section.id,
        name: batch.section.name,
        classGradeId: batch.section.classGradeId,
        className: batch.section.classGrade.name,
      },
      issueDate: todayUtc(),
      // Dates are per student on a bespoke schedule; the earliest is indicative.
      dueDate:
        batch.toGenerate
          .map((r) => r.installment.dueDate)
          .sort((a, b) => a.getTime() - b.getTime())[0] ?? todayUtc(),
      bankAccountId: null,
      willGenerate: batch.toGenerate.map((r) => ({
        studentId: r.student.id,
        fullName: r.student.fullName,
        rollNo: r.student.rollNo,
        discountName: null,
        grossAmount: r.installment.amount,
        discountAmount: 0,
        netAmount: r.installment.amount,
        installmentSeq: r.installment.seq,
        installmentCount: r.installmentCount,
        dueDate: r.installment.dueDate,
        items: [],
      })),
      // Mapped into the shape the existing preview UI already renders.
      alreadyBilled: batch.skipped.map((s) => ({
        studentId: s.studentId,
        fullName: s.fullName,
        rollNo: s.rollNo,
        challanNo: s.challanNo ?? SKIP_LABELS[s.reason] ?? s.reason,
      })),
      skipped: batch.skipped,
      counts: {
        willGenerate: batch.toGenerate.length,
        alreadyBilled: batch.skipped.length,
        total: batch.toGenerate.length + batch.skipped.length,
      },
      totals: { grossAmount: netAmount, discountAmount: 0, netAmount },
    };
  }

  /**
   * Write the installment challans. One transaction, one line item each —
   * the plan's own amount, NOT the fee heads, because the plan already encodes
   * the year's fee and re-deriving it would double-bill.
   */
  private async generateInstallments(
    dto: GenerateChallansDto,
    actor: Actor,
    onlyStudentId?: string,
  ) {
    const batch = await this.buildInstallmentBatch(dto, actor, onlyStudentId);
    if (!batch.toGenerate.length) {
      return {
        generated: 0,
        skipped: batch.skipped.length,
        failed: 0,
        challanIds: [] as string[],
        alreadyBilled: [],
        skippedDetail: batch.skipped,
      };
    }

    const bankAccountId = await this.resolveBankAccount(
      batch.schoolId,
      dto.bankAccountId,
    );
    const issueDate = dto.issueDate ? utcMidnight(dto.issueDate) : todayUtc();

    let challanIds: string[];
    try {
      challanIds = await this.prisma.$transaction(async (tx) => {
        const existingCount = await tx.challan.count({
          where: { schoolId: batch.schoolId },
        });
        const ids: string[] = [];
        for (const [i, row] of batch.toGenerate.entries()) {
          const created = await tx.challan.create({
            data: {
              schoolId: batch.schoolId,
              challanNo: formatChallanNo(
                batch.school.feeChallanPrefix,
                existingCount + i + 1,
              ),
              studentId: row.student.id,
              academicYearId: dto.academicYearId,
              periodYear: row.periodYear,
              periodMonth: row.periodMonth,
              classGradeId: batch.section.classGradeId,
              sectionId: batch.section.id,
              className: batch.section.classGrade.name,
              sectionName: batch.section.name,
              issueDate,
              dueDate: row.installment.dueDate,
              grossAmount: row.installment.amount,
              discountAmount: 0,
              netAmount: row.installment.amount,
              paidAmount: 0,
              status: resolveChallanStatus(0, row.installment.amount),
              bankAccountId,
              generatedByUserId: actor.userId,
              generationType: ChallanGenerationType.INSTALLMENT,
              installmentPlanId: row.planId,
              installmentId: row.installment.id,
              installmentSeq: row.installment.seq,
              items: {
                create: [
                  {
                    feeHeadId: null,
                    label: `Installment ${row.installment.seq} of ${row.installmentCount}`,
                    amount: row.installment.amount,
                    kind: ChallanItemKind.FEE,
                    sortOrder: 0,
                  },
                ],
              },
            },
            select: { id: true },
          });
          ids.push(created.id);
        }
        return ids;
      });
    } catch (e) {
      // The unique index on installmentId is the real duplicate guard; the
      // pre-flight check above only makes the message friendlier.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException(
          'One of these installments was billed while this ran. Preview again to see the current state.',
        );
      }
      throw e;
    }

    await this.invalidateFeeCache(batch.schoolId);
    await this.audit.record(actor.userId, 'FEE_CHALLAN_GENERATE', {
      schoolId: batch.schoolId,
      entityType: 'Challan',
      metadata: {
        generationType: ChallanGenerationType.INSTALLMENT,
        installmentSeq: batch.seq,
        sectionId: batch.section.id,
        generated: challanIds.length,
        skipped: batch.skipped.length,
      },
    });

    await this.notifyChallansIssued(
      batch.toGenerate.map((row, i) => ({
        studentId: row.student.id,
        fullName: row.student.fullName,
        challanId: challanIds[i],
        netAmount: row.installment.amount,
      })),
      batch.toGenerate[0].periodYear,
      batch.toGenerate[0].periodMonth,
      batch.toGenerate[0].installment.dueDate,
      batch.school.currency,
    );

    return {
      generated: challanIds.length,
      skipped: batch.skipped.length,
      failed: 0,
      challanIds,
      alreadyBilled: [],
      skippedDetail: batch.skipped,
    };
  }

  // ==== Installment generation =============================================

  /**
   * Everything the "Generate Installment Challan" modal needs for one student,
   * in a CONSTANT number of queries: their plans, every row of each, and which
   * rows are already billed.
   *
   * `alreadyGenerated` is read from `Challan.installmentId` — the same column
   * whose unique index enforces the rule — so what the modal disables and what
   * the database refuses can never disagree.
   */
  async installmentOptions(studentId: string, actor: Actor) {
    this.ensureAdmin(actor);
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        schoolId: true,
        fullName: true,
        rollNo: true,
        admissionNo: true,
        school: { select: { currency: true } },
        enrollments: {
          where: { status: 'ACTIVE' },
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            section: {
              select: {
                id: true,
                name: true,
                classGrade: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    this.enforceScope(actor, student.schoolId);

    const [plans, challans] = await Promise.all([
      this.prisma.feeInstallmentPlan.findMany({
        where: { studentId },
        orderBy: { startDate: 'desc' },
        select: {
          id: true,
          isActive: true,
          totalAmount: true,
          academicYearId: true,
          academicYear: { select: { name: true } },
          installments: {
            orderBy: { seq: 'asc' },
            select: { id: true, seq: true, amount: true, dueDate: true },
          },
        },
      }),
      // Outstanding across live challans — the modal's "Current Balance".
      this.prisma.challan.findMany({
        where: { studentId, status: { not: ChallanStatus.CANCELLED } },
        select: {
          netAmount: true,
          paidAmount: true,
          status: true,
          installmentId: true,
          challanNo: true,
          id: true,
        },
      }),
    ]);

    // The balance rides along on a query already being made, so an
    // already-generated row can offer "record payment" instead of dead-ending
    // at a disabled card.
    const billed = new Map(
      challans
        .filter((c) => c.installmentId)
        .map((c) => [
          c.installmentId!,
          {
            id: c.id,
            challanNo: c.challanNo,
            status: c.status,
            balance: Math.max(0, c.netAmount - c.paidAmount),
          },
        ]),
    );

    const enrollment = student.enrollments[0];
    return {
      currency: student.school.currency,
      student: {
        id: student.id,
        fullName: student.fullName,
        rollNo: student.rollNo,
        admissionNo: student.admissionNo,
        className: enrollment?.section.classGrade.name ?? null,
        sectionName: enrollment?.section.name ?? null,
      },
      outstanding: challans.reduce(
        (sum, c) => sum + Math.max(0, c.netAmount - c.paidAmount),
        0,
      ),
      plans: plans.map((p) => ({
        id: p.id,
        academicYearId: p.academicYearId,
        // The model stores no plan name, so one is derived from what it IS —
        // the year it covers and how many payments it splits into.
        label: `${p.academicYear.name} — ${p.installments.length} installment${p.installments.length === 1 ? '' : 's'}`,
        academicYearName: p.academicYear.name,
        totalAmount: p.totalAmount,
        isActive: p.isActive,
        installments: p.installments.map((i) => {
          const existing = billed.get(i.id);
          return {
            id: i.id,
            seq: i.seq,
            amount: i.amount,
            dueDate: i.dueDate,
            status: existing ? 'ALREADY_GENERATED' : 'AVAILABLE',
            challanId: existing?.id ?? null,
            challanNo: existing?.challanNo ?? null,
            challanStatus: existing?.status ?? null,
            challanBalance: existing?.balance ?? null,
          };
        }),
      })),
    };
  }

  /**
   * Section-wide installment options: for each row number, how many students
   * can be billed and how many already have been.
   *
   * Plans belong to individual students, so a section has no single plan to
   * pick from — the shared thing is the row NUMBER. Three bulk queries for the
   * whole roster; a per-student lookup here would be the N+1 to avoid.
   */
  async sectionInstallmentOptions(
    query: SectionInstallmentQueryDto,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);

    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        sectionId: query.sectionId,
        academicYearId: query.academicYearId,
        status: 'ACTIVE',
      },
      select: { studentId: true },
    });
    const studentIds = enrollments.map((e) => e.studentId);
    if (!studentIds.length) {
      return {
        rows: [],
        studentsOnPlan: 0,
        studentsWithoutPlan: 0,
        currency: undefined,
      };
    }

    const [plans, school] = await Promise.all([
      this.prisma.feeInstallmentPlan.findMany({
        where: {
          schoolId,
          studentId: { in: studentIds },
          academicYearId: query.academicYearId,
          isActive: true,
        },
        select: {
          id: true,
          studentId: true,
          installments: {
            orderBy: { seq: 'asc' },
            select: { id: true, seq: true, amount: true, dueDate: true },
          },
        },
      }),
      this.prisma.school.findUnique({
        where: { id: schoolId },
        select: { currency: true },
      }),
    ]);

    const allInstallmentIds = plans.flatMap((p) =>
      p.installments.map((i) => i.id),
    );
    const billed = allInstallmentIds.length
      ? new Set(
          (
            await this.prisma.challan.findMany({
              where: { installmentId: { in: allInstallmentIds } },
              select: { installmentId: true },
            })
          ).map((c) => c.installmentId!),
        )
      : new Set<string>();

    // Bucket by seq across every student's plan.
    const bySeq = new Map<
      number,
      {
        eligible: number;
        alreadyGenerated: number;
        amount: number;
        earliestDue: Date;
      }
    >();
    for (const plan of plans) {
      for (const i of plan.installments) {
        const row = bySeq.get(i.seq) ?? {
          eligible: 0,
          alreadyGenerated: 0,
          amount: i.amount,
          earliestDue: i.dueDate,
        };
        if (billed.has(i.id)) row.alreadyGenerated += 1;
        else row.eligible += 1;
        if (i.dueDate < row.earliestDue) row.earliestDue = i.dueDate;
        bySeq.set(i.seq, row);
      }
    }

    return {
      currency: school?.currency,
      studentsOnPlan: plans.length,
      studentsWithoutPlan: studentIds.length - plans.length,
      rows: [...bySeq.entries()]
        .sort(([a], [b]) => a - b)
        .map(([seq, r]) => ({
          seq,
          eligible: r.eligible,
          alreadyGenerated: r.alreadyGenerated,
          // Amounts and dates can differ per student on a bespoke schedule, so
          // these are indicative — each challan carries its own student's row.
          sampleAmount: r.amount,
          earliestDueDate: r.earliestDue,
        })),
    };
  }

  // ==== Reads ==============================================================

  async list(query: ChallanQueryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);
    const where = this.buildListWhere(query, schoolId);

    const { skip, take, page, pageSize } = resolvePagination(query);
    const [total, rows] = await Promise.all([
      this.prisma.challan.count({ where }),
      this.prisma.challan.findMany({
        where,
        orderBy: [{ issueDate: 'desc' }, { challanNo: 'desc' }],
        skip,
        take,
        select: this.listSelect(),
      }),
    ]);

    return {
      items: rows.map((r) => this.decorate(r)),
      total,
      page,
      pageSize,
    };
  }

  private buildListWhere(
    query: ChallanQueryDto,
    schoolId: string,
  ): Prisma.ChallanWhereInput {
    const where: Prisma.ChallanWhereInput = { schoolId };
    if (query.academicYearId) where.academicYearId = query.academicYearId;
    if (query.classGradeId) where.classGradeId = query.classGradeId;
    if (query.sectionId) where.sectionId = query.sectionId;
    if (query.studentId) where.studentId = query.studentId;
    if (query.periodYear) where.periodYear = query.periodYear;
    if (query.periodMonth) where.periodMonth = query.periodMonth;
    if (query.status) where.status = query.status;

    if (query.from || query.to) {
      where.issueDate = {
        ...(query.from ? { gte: utcMidnight(query.from) } : {}),
        ...(query.to ? { lte: utcMidnight(query.to) } : {}),
      };
    }

    // Overdue is derived: past due AND not settled/cancelled.
    if (query.overdue === 'true') {
      where.dueDate = { lt: todayUtc() };
      where.status = {
        in: [ChallanStatus.UNPAID, ChallanStatus.PARTIALLY_PAID],
      };
    }

    if (query.search?.trim()) {
      const s = query.search.trim();
      where.OR = [
        { challanNo: { contains: s, mode: 'insensitive' } },
        { student: { fullName: { contains: s, mode: 'insensitive' } } },
        { student: { rollNo: { contains: s, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  private listSelect() {
    return {
      id: true,
      challanNo: true,
      studentId: true,
      academicYearId: true,
      periodYear: true,
      periodMonth: true,
      className: true,
      sectionName: true,
      classGradeId: true,
      sectionId: true,
      issueDate: true,
      dueDate: true,
      grossAmount: true,
      discountAmount: true,
      netAmount: true,
      paidAmount: true,
      status: true,
      cancelledAt: true,
      student: { select: { id: true, fullName: true, rollNo: true } },
    } satisfies Prisma.ChallanSelect;
  }

  /** Attach the derived fields the UI needs but the DB deliberately doesn't store. */
  private decorate<
    T extends {
      status: string;
      dueDate: Date;
      netAmount: number;
      paidAmount: number;
    },
  >(row: T) {
    const status = row.status as ChallanStatus;
    return {
      ...row,
      isOverdue: isOverdue(
        {
          status,
          dueDate: row.dueDate,
          netAmount: row.netAmount,
          paidAmount: row.paidAmount,
        },
        todayUtc(),
      ),
      balance: Math.max(0, row.netAmount - row.paidAmount),
    };
  }

  /**
   * Full detail for a filtered set of challans, for printing a whole class at
   * once.
   *
   * ONE query with the items and bank account included, rather than the N
   * detail requests a client-side loop would make. Capped, because "print
   * everything" against a year of billing is a request nobody means to send.
   */
  async printBatch(query: ChallanQueryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);
    const where = this.buildListWhere(query, schoolId);

    // A settled challan is nothing to hand out — printing one wastes paper
    // and invites a second payment. Composed with AND so an explicit
    //  filter yields nothing rather than overriding this.
    const printable: Prisma.ChallanWhereInput = {
      ...where,
      AND: [{ status: { not: ChallanStatus.PAID } }],
    };

    const [rows, skippedPaid] = await Promise.all([
      this.prisma.challan.findMany({
        where: printable,
        // Printed in the order they'd be handed out.
        orderBy: [
          { sectionName: 'asc' },
          { student: { rollNo: 'asc' } },
          { challanNo: 'asc' },
        ],
        take: PRINT_BATCH_LIMIT + 1,
        select: {
          ...this.listSelect(),
          schoolId: true,
          bankAccountId: true,
          cancelReason: true,
          createdAt: true,
          items: {
            orderBy: { sortOrder: 'asc' as const },
            select: {
              id: true,
              label: true,
              amount: true,
              kind: true,
              sortOrder: true,
              feeHeadId: true,
            },
          },
          bankAccount: {
            select: {
              bankName: true,
              accountTitle: true,
              accountNumber: true,
              iban: true,
              branch: true,
            },
          },
          academicYear: { select: { id: true, name: true } },
          school: {
            select: {
              id: true,
              name: true,
              currency: true,
              // Fallback payment instructions for printing: a challan issued
              // before a default account existed has no snapshot of its own, and
              // a printed bill with nowhere to pay is useless. Display only — the
              // challan's own bankAccountId is untouched.
              bankAccounts: {
                where: { isActive: true },
                orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
                take: 1,
                select: {
                  bankName: true,
                  accountTitle: true,
                  accountNumber: true,
                  iban: true,
                  branch: true,
                },
              },
            },
          },
        },
      }),
      // Reported so the page can say what it left out, rather than quietly
      // printing fewer sheets than the operator expected.
      this.prisma.challan.count({
        where: { ...where, AND: [{ status: ChallanStatus.PAID }] },
      }),
    ]);

    if (rows.length > PRINT_BATCH_LIMIT) {
      throw new BadRequestException(
        `That selection is over ${PRINT_BATCH_LIMIT} challans. Narrow it by class, section or month before printing.`,
      );
    }

    return {
      items: rows.map((r) => this.decorate(r)),
      total: rows.length,
      skippedPaid,
    };
  }

  /** Detail read, scoped at the OBJECT level — role alone isn't enough here. */
  async findOne(id: string, actor: Actor) {
    const challan = await this.prisma.challan.findUnique({
      where: { id },
      select: {
        ...this.listSelect(),
        schoolId: true,
        bankAccountId: true,
        cancelReason: true,
        createdAt: true,
        items: {
          orderBy: { sortOrder: 'asc' as const },
          select: {
            id: true,
            label: true,
            amount: true,
            kind: true,
            sortOrder: true,
            feeHeadId: true,
          },
        },
        bankAccount: {
          select: {
            bankName: true,
            accountTitle: true,
            accountNumber: true,
            iban: true,
            branch: true,
          },
        },
        academicYear: { select: { id: true, name: true } },
        school: {
          select: {
            id: true,
            name: true,
            currency: true,
            // Fallback payment instructions for printing: a challan issued
            // before a default account existed has no snapshot of its own, and
            // a printed bill with nowhere to pay is useless. Display only — the
            // challan's own bankAccountId is untouched.
            bankAccounts: {
              where: { isActive: true },
              orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
              take: 1,
              select: {
                bankName: true,
                accountTitle: true,
                accountNumber: true,
                iban: true,
                branch: true,
              },
            },
          },
        },
      },
    });
    if (!challan) throw new NotFoundException('Challan not found');

    await this.assertChallanReadable(challan, actor);
    return this.decorate(challan);
  }

  private async assertChallanReadable(
    challan: { schoolId: string; studentId: string; sectionId: string | null },
    actor: Actor,
  ) {
    if (actor.role === Role.SUPER_ADMIN) return;
    if (actor.schoolId !== challan.schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
    if (actor.role === Role.SCHOOL_ADMIN) return;

    if (actor.role === Role.STUDENT) {
      const own = await this.prisma.studentProfile.findFirst({
        where: { id: challan.studentId, userId: actor.userId },
        select: { id: true },
      });
      if (!own) throw new ForbiddenException('Not allowed');
      return;
    }

    if (actor.role === Role.PARENT) {
      const link = await this.prisma.parentStudent.findFirst({
        where: {
          studentId: challan.studentId,
          parent: { userId: actor.userId },
        },
        select: { studentId: true },
      });
      if (!link) throw new ForbiddenException('Not allowed');
      return;
    }

    throw new ForbiddenException('Not allowed');
  }

  /** Per-class Created / Not Created / Partially covered grid for one month. */
  async coverage(query: ChallanCoverageQueryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);

    const classGrades = await this.prisma.classGrade.findMany({
      where: { schoolId, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        sections: {
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    const sectionIds = classGrades.flatMap((c) => c.sections.map((s) => s.id));
    if (!sectionIds.length) return { rows: [], currency: undefined };

    const [enrollmentCounts, challanAgg, school] = await Promise.all([
      this.prisma.enrollment.groupBy({
        by: ['sectionId'],
        where: {
          sectionId: { in: sectionIds },
          academicYearId: query.academicYearId,
          status: 'ACTIVE',
        },
        _count: { _all: true },
      }),
      this.prisma.challan.groupBy({
        by: ['sectionId'],
        where: {
          schoolId,
          sectionId: { in: sectionIds },
          academicYearId: query.academicYearId,
          periodYear: query.periodYear,
          periodMonth: query.periodMonth,
          status: { not: ChallanStatus.CANCELLED },
        },
        _count: { _all: true },
        _sum: { netAmount: true, paidAmount: true },
      }),
      this.prisma.school.findUnique({
        where: { id: schoolId },
        select: { currency: true },
      }),
    ]);

    const studentsBySection = new Map(
      enrollmentCounts.map((e) => [e.sectionId, e._count._all]),
    );
    const challansBySection = new Map(
      challanAgg.map((c) => [
        c.sectionId,
        {
          count: c._count._all,
          billed: c._sum.netAmount ?? 0,
          collected: c._sum.paidAmount ?? 0,
        },
      ]),
    );

    const rows = classGrades.map((grade) => {
      let students = 0;
      let challans = 0;
      let billed = 0;
      let collected = 0;
      for (const section of grade.sections) {
        students += studentsBySection.get(section.id) ?? 0;
        const agg = challansBySection.get(section.id);
        if (agg) {
          challans += agg.count;
          billed += agg.billed;
          collected += agg.collected;
        }
      }
      return {
        classGradeId: grade.id,
        className: grade.name,
        sections: grade.sections,
        sectionCount: grade.sections.length,
        students,
        challans,
        billed,
        collected,
        // Real data produces "partial" constantly (a student admitted after
        // generation), so it is a first-class state, not an edge case.
        status:
          students === 0
            ? 'NO_STUDENTS'
            : challans === 0
              ? 'NOT_CREATED'
              : challans >= students
                ? 'CREATED'
                : 'PARTIAL',
      };
    });

    return { rows, currency: school?.currency };
  }

  /**
   * Batch badge status for a page of students. Uncached and separate from the
   * cached student list, so a payment never forces a students-cache flush.
   */
  async batchStatus(dto: StudentFeeStatusDto, actor: Actor) {
    const allowedIds = [...new Set(dto.studentIds)];
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);

    if (!allowedIds.length) return { statuses: {} };

    // Two bulk queries for the page, never one per row — the plan flag rides
    // along so the badge costs nothing extra per student.
    const [challans, plans] = await Promise.all([
      this.prisma.challan.findMany({
        where: {
          schoolId,
          studentId: { in: allowedIds },
          status: { not: ChallanStatus.CANCELLED },
        },
        select: {
          studentId: true,
          netAmount: true,
          paidAmount: true,
          status: true,
          dueDate: true,
        },
      }),
      this.prisma.feeInstallmentPlan.findMany({
        where: { schoolId, studentId: { in: allowedIds }, isActive: true },
        select: { studentId: true },
      }),
    ]);
    const onPlan = new Set(plans.map((p) => p.studentId));

    const today = todayUtc();
    const statuses: Record<
      string,
      {
        status: ChallanStatus | 'OVERDUE' | 'NO_CHALLANS';
        outstanding: number;
        challanCount: number;
        hasInstallmentPlan: boolean;
      }
    > = {};
    for (const id of allowedIds) {
      statuses[id] = {
        status: 'NO_CHALLANS',
        outstanding: 0,
        challanCount: 0,
        hasInstallmentPlan: onPlan.has(id),
      };
    }

    for (const c of challans) {
      const entry = statuses[c.studentId];
      if (!entry) continue;
      entry.challanCount += 1;
      entry.outstanding += Math.max(0, c.netAmount - c.paidAmount);
      const overdue = isOverdue(
        {
          status: c.status as ChallanStatus,
          dueDate: c.dueDate,
          netAmount: c.netAmount,
          paidAmount: c.paidAmount,
        },
        today,
      );
      // Worst state wins: OVERDUE > UNPAID/PARTIAL > PAID.
      if (overdue) entry.status = 'OVERDUE';
      else if (entry.status !== 'OVERDUE') {
        if (c.status !== ChallanStatus.PAID) {
          entry.status = c.status as ChallanStatus;
        } else if (entry.status === 'NO_CHALLANS') {
          entry.status = ChallanStatus.PAID;
        }
      }
    }

    return { statuses };
  }

  // ==== Read-only portals ==================================================

  /**
   * A student's own fees, or a parent's child's. `studentId` picks the child
   * for a parent with several; it must still pass the link check.
   */
  async myFees(actor: Actor, studentId?: string) {
    const student = await this.resolveOwnStudent(actor, studentId);
    return this.studentFeeHistory(student.id);
  }

  /** One student's history, scoped per role. */
  async studentChallans(studentId: string, actor: Actor) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { id: true, schoolId: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    await this.assertStudentReadable(student, actor);
    return this.studentFeeHistory(student.id);
  }

  /** Children a parent can switch between in their portal. */
  async myChildren(actor: Actor) {
    if (actor.role !== Role.PARENT) throw new ForbiddenException('Not allowed');
    const links = await this.prisma.parentStudent.findMany({
      where: { parent: { userId: actor.userId } },
      select: {
        student: { select: { id: true, fullName: true, rollNo: true } },
      },
    });
    return links.map((l) => l.student);
  }

  private async studentFeeHistory(studentId: string) {
    const [student, challans, installmentPlan] = await Promise.all([
      this.prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: {
          id: true,
          fullName: true,
          rollNo: true,
          school: { select: { currency: true } },
        },
      }),
      this.prisma.challan.findMany({
        where: { studentId },
        orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
        select: this.listSelect(),
      }),
      // Rides the payload the student, parent AND teacher views already fetch —
      // no extra request and no second authorization path. The caller has
      // already object-scoped this student.
      this.installmentPlans.loadPlan(studentId),
    ]);

    const rows = challans.map((c) => this.decorate(c));
    const active = rows.filter((c) => c.status !== ChallanStatus.CANCELLED);
    const nextDue = active
      .filter((c) => c.balance > 0)
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())[0];

    return {
      student: {
        id: student?.id,
        fullName: student?.fullName,
        rollNo: student?.rollNo,
      },
      currency: student?.school.currency ?? 'PKR',
      summary: {
        totalBilled: active.reduce((s, c) => s + c.netAmount, 0),
        totalPaid: active.reduce((s, c) => s + c.paidAmount, 0),
        outstanding: active.reduce((s, c) => s + c.balance, 0),
        nextDueDate: nextDue?.dueDate ?? null,
        overdueCount: active.filter((c) => c.isOverdue).length,
      },
      challans: rows,
      installmentPlan,
    };
  }

  /** The StudentProfile the actor is entitled to read as "their own". */
  private async resolveOwnStudent(actor: Actor, studentId?: string) {
    if (actor.role === Role.STUDENT) {
      const own = await this.prisma.studentProfile.findFirst({
        where: { userId: actor.userId },
        select: { id: true, schoolId: true },
      });
      if (!own) {
        throw new NotFoundException('No student record for this account');
      }
      return own;
    }

    if (actor.role === Role.PARENT) {
      const links = await this.prisma.parentStudent.findMany({
        where: {
          parent: { userId: actor.userId },
          ...(studentId ? { studentId } : {}),
        },
        select: { student: { select: { id: true, schoolId: true } } },
      });
      if (!links.length) {
        throw new ForbiddenException(
          studentId ? 'Not allowed' : 'No linked students for this account',
        );
      }
      return links[0].student;
    }

    throw new ForbiddenException('Not allowed');
  }

  private async assertStudentReadable(
    student: { id: string; schoolId: string },
    actor: Actor,
  ) {
    if (actor.role === Role.SUPER_ADMIN) return;
    if (actor.schoolId !== student.schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
    if (actor.role === Role.SCHOOL_ADMIN) return;

    if (actor.role === Role.STUDENT) {
      const own = await this.prisma.studentProfile.findFirst({
        where: { id: student.id, userId: actor.userId },
        select: { id: true },
      });
      if (!own) throw new ForbiddenException('Not allowed');
      return;
    }

    if (actor.role === Role.PARENT) {
      const link = await this.prisma.parentStudent.findFirst({
        where: { studentId: student.id, parent: { userId: actor.userId } },
        select: { studentId: true },
      });
      if (!link) throw new ForbiddenException('Not allowed');
      return;
    }

    throw new ForbiddenException('Not allowed');
  }

  /**
   * Tell each student and their guardians about THEIR challan.
   *
   * Personalised per student (name, amount, due date, deep link) but batched:
   * two queries resolve the whole roster's recipients, and the listener writes
   * every row in one createMany. Only actually-created challans are passed in,
   * and this runs AFTER the transaction commits — so a retried or raced
   * generation, whose plan finds everyone already billed, notifies nobody.
   */
  private async notifyChallansIssued(
    issued: {
      studentId: string;
      fullName: string;
      challanId: string;
      netAmount: number;
    }[],
    periodYear: number,
    periodMonth: number,
    dueDate: Date,
    currency: string,
  ) {
    if (!issued.length) return;

    const studentIds = issued.map((c) => c.studentId);
    const [selfByStudent, parentsByStudent] = await Promise.all([
      studentUserIdByStudent(this.prisma, studentIds),
      parentUserIdsByStudent(this.prisma, studentIds),
    ]);

    const period = `${MONTH_NAMES[periodMonth - 1]} ${periodYear}`;
    const due = dueDate.toISOString().slice(0, 10);

    const items = issued
      .map((c) => {
        const self = selfByStudent.get(c.studentId);
        const userIds = [
          ...new Set([
            ...(self ? [self] : []),
            ...(parentsByStudent.get(c.studentId) ?? []),
          ]),
        ];
        return {
          userIds,
          title: 'Fee challan issued',
          body: `${c.fullName} — ${period} fee challan of ${formatMinorUnits(c.netAmount, currency)} is ready. Due ${due}.`,
          // Portal-relative: the bell prefixes the viewer's dashboard, so one
          // link resolves to /student-dashboard/fees/… or /parent-dashboard/fees/…
          link: `/fees/${c.challanId}`,
          entityType: 'Challan',
          entityId: c.challanId,
        };
      })
      .filter((i) => i.userIds.length);

    if (!items.length) return;

    this.eventEmitter.emit(NOTIFICATION_CREATE_BATCH, {
      type: 'FEE_CHALLAN_ISSUED',
      notifyPreferenceKey: 'notifyGrades',
      items,
    } as NotificationCreateBatchEvent);
  }

  private invalidateFeeCache(schoolId: string) {
    return (
      this.cache?.delByPrefix(feesCachePrefix(schoolId)) ?? Promise.resolve()
    );
  }
}
