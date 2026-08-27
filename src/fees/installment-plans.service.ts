import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { CacheService } from '../common/services/cache.service';
import { AuditLogService } from '../audit/audit.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { allocateInstallments, remainingBalance } from './fee-calculator';
import {
  ChallanStatus,
  InstallmentStatus,
  PaymentSubmissionStatus,
} from './fees.types';
import { SetInstallmentPlanDto } from './dto/installment-plan.dto';
import { notifyFeeAllocationUpdated } from './fee-notifications';
import { feesCachePrefix } from './fees-cache';
import { formatMinorUnits } from './money.util';

/** UTC midnight — matches the `@db.Date` columns, so a due date can't shift a day. */
const utcMidnight = (value: string | Date): Date => {
  const d = new Date(value);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
};
const todayUtc = () => utcMidnight(new Date());

/**
 * One student's installment plan for one academic year.
 *
 * A plan is a schedule of PROMISES — not a bill and not a receipt. Nothing in
 * challan generation reads it, so editing a plan can never alter an issued
 * challan; and it has no relation to `FeeHead`, so it can never move the
 * school-wide configuration or another student.
 *
 * `paidAmount` / `remainingAmount` / `status` are DERIVED on every read by
 * `allocateInstallments()` over the student's payment ledger for that year —
 * which is why recording or voiding a payment needs no installment write at all.
 */
@Injectable()
export class InstallmentPlansService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, cache);
  }

  /**
   * The plan with its derived schedule, or `null` when the student has none.
   * Object-level scoped: role alone can't decide this, since a parent must not
   * read another parent's child.
   */
  async get(studentId: string, actor: Actor) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        schoolId: true,
        fullName: true,
        school: { select: { currency: true } },
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    await this.assertReadable(student, actor);

    const plan = await this.loadPlan(studentId);
    return {
      currency: student.school.currency,
      student: { id: student.id, fullName: student.fullName },
      plan,
    };
  }

  /**
   * Load one student's plan and derive its schedule. Shared with the student
   * fee-history payload so both surfaces agree by construction.
   *
   * `academicYearId` picks a specific year; omitted, it takes the most recent
   * plan — a student normally has exactly one that matters.
   */
  async loadPlan(studentId: string, academicYearId?: string) {
    const plan = await this.prisma.feeInstallmentPlan.findFirst({
      where: { studentId, ...(academicYearId ? { academicYearId } : {}) },
      orderBy: { startDate: 'desc' },
      select: {
        id: true,
        academicYearId: true,
        totalAmount: true,
        startDate: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        academicYear: { select: { id: true, name: true } },
        installments: {
          orderBy: { seq: 'asc' },
          select: { id: true, seq: true, amount: true, dueDate: true },
        },
      },
    });
    if (!plan) return null;

    const pool = await this.paidPoolFor(studentId, plan.academicYearId);
    const schedule = allocateInstallments(
      plan.installments,
      pool,
      todayUtc(),
    ).map((i) => ({
      id: i.id,
      seq: i.seq,
      amount: i.amount,
      dueDate: i.dueDate,
      paidAmount: i.paidAmount,
      remainingAmount: i.remainingAmount,
      status: i.status,
    }));

    const paidTotal = schedule.reduce((s, i) => s + i.paidAmount, 0);
    const nextDue = schedule.find((i) => i.remainingAmount > 0);
    const { payable, payableBlockedReason } = await this.resolvePayable(
      studentId,
      plan.academicYearId,
      plan.isActive,
      schedule,
    );

    return {
      id: plan.id,
      academicYearId: plan.academicYearId,
      academicYearName: plan.academicYear.name,
      totalAmount: plan.totalAmount,
      startDate: plan.startDate,
      isActive: plan.isActive,
      installmentCount: schedule.length,
      paidCount: schedule.filter((i) => i.remainingAmount === 0).length,
      paidAmount: paidTotal,
      outstandingAmount: Math.max(0, plan.totalAmount - paidTotal),
      nextDueDate: nextDue?.dueDate ?? null,
      overdueCount: schedule.filter(
        (i) => i.status === InstallmentStatus.OVERDUE,
      ).length,
      installments: schedule,
      // What the family can actually pay right now, and against which bill.
      payable,
      payableBlockedReason,
    };
  }

  /**
   * THE definition of "which installment is being paid", used by the portal UI
   * and by the submission guard alike — so the row the parent clicks and the
   * row the server credits are the same row by construction, not by agreement.
   *
   * It is always the OLDEST unsettled installment, because that is where
   * `allocateInstallments` puts the money. Offering installment 3 while 1 is
   * unpaid would show a family one thing and credit another.
   *
   * A payment still belongs to a CHALLAN — a plan is a schedule, not a bill —
   * so this also resolves the challan the money attaches to: the oldest
   * unsettled one for the same academic year.
   */
  private async resolvePayable(
    studentId: string,
    academicYearId: string,
    isActive: boolean,
    schedule: {
      id: string;
      seq: number;
      amount: number;
      dueDate: Date;
      remainingAmount: number;
    }[],
  ) {
    const blocked = (reason: string | null) => ({
      payable: null,
      payableBlockedReason: reason,
    });

    if (!isActive) return blocked('This installment plan is switched off.');

    const next = schedule.find((i) => i.remainingAmount > 0);
    // Nothing owed is not a blockage — the schedule is simply finished.
    if (!next) return blocked(null);

    const unsettled = {
      status: { in: [ChallanStatus.UNPAID, ChallanStatus.PARTIALLY_PAID] },
    };
    const select = {
      id: true,
      challanNo: true,
      netAmount: true,
      paidAmount: true,
    };

    // The challan issued FOR this installment, when there is one — an exact
    // link beats a heuristic. Falls back to the oldest unsettled challan for
    // students billed the ordinary monthly way.
    const challan =
      (await this.prisma.challan.findFirst({
        where: { installmentId: next.id, ...unsettled },
        select,
      })) ??
      (await this.prisma.challan.findFirst({
        where: { studentId, academicYearId, ...unsettled },
        orderBy: [{ dueDate: 'asc' }, { challanNo: 'asc' }],
        select,
      }));
    if (!challan) {
      return blocked(
        'No unpaid challan has been issued yet, so there is nothing to pay against. The school issues challans each billing period.',
      );
    }

    // A receipt already under review. Surfaced rather than silently allowing a
    // second one, which would be double-paid if both were verified.
    const pending = await this.prisma.paymentSubmission.findFirst({
      where: {
        studentId,
        installmentId: next.id,
        status: PaymentSubmissionStatus.PENDING_VERIFICATION,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, amount: true, createdAt: true },
    });

    const challanBalance = remainingBalance(
      challan.netAmount,
      challan.paidAmount,
    );

    return {
      payable: {
        installment: {
          id: next.id,
          seq: next.seq,
          amount: next.amount,
          dueDate: next.dueDate,
          remainingAmount: next.remainingAmount,
        },
        challan: {
          id: challan.id,
          challanNo: challan.challanNo,
          balance: challanBalance,
        },
        // Capped by BOTH: an installment can't take more than it owes, and a
        // challan can't take more than its balance.
        maxAmount: Math.min(next.remainingAmount, challanBalance),
        pendingSubmission: pending,
      },
      payableBlockedReason: null,
    };
  }

  /**
   * Active-plan summaries for many students in ONE query — the list path.
   * The verification queue needs "is this an installment student, and X of Y"
   * per row; loading a plan per row would be the N+1 this module avoids.
   */
  async summariesFor(
    studentIds: string[],
  ): Promise<
    Map<
      string,
      { totalAmount: number; installmentCount: number; isActive: boolean }
    >
  > {
    const ids = [...new Set(studentIds)];
    if (!ids.length) return new Map();

    const plans = await this.prisma.feeInstallmentPlan.findMany({
      where: { studentId: { in: ids } },
      select: {
        studentId: true,
        totalAmount: true,
        isActive: true,
        // Bounded by MAX_INSTALLMENTS, so selecting the ids to count them is
        // cheaper than a second grouped query.
        installments: { select: { id: true } },
      },
    });

    return new Map(
      plans.map((p) => [
        p.studentId,
        {
          totalAmount: p.totalAmount,
          installmentCount: p.installments.length,
          isActive: p.isActive,
        },
      ]),
    );
  }

  /**
   * Remaining on ONE installment, derived from the ledger like everything else.
   * `null` means the row no longer exists — a plan edit replaces its rows, and
   * `PaymentSubmission.installmentId` is SetNull, so a stale link is expected.
   */
  async remainingOnInstallment(
    studentId: string,
    installmentId: string,
  ): Promise<{ remainingAmount: number; seq: number } | null> {
    const installment = await this.prisma.feeInstallment.findUnique({
      where: { id: installmentId },
      select: { plan: { select: { studentId: true, academicYearId: true } } },
    });
    if (!installment || installment.plan.studentId !== studentId) return null;

    const plan = await this.loadPlan(
      studentId,
      installment.plan.academicYearId,
    );
    const row = plan?.installments.find((i) => i.id === installmentId);
    return row ? { remainingAmount: row.remainingAmount, seq: row.seq } : null;
  }

  /**
   * The money the waterfall allocates: every non-voided payment on the
   * student's non-cancelled challans FOR THAT ACADEMIC YEAR. One query.
   */
  private async paidPoolFor(
    studentId: string,
    academicYearId: string,
  ): Promise<number> {
    const agg = await this.prisma.payment.aggregate({
      where: {
        voidedAt: null,
        challan: {
          studentId,
          academicYearId,
          status: { not: ChallanStatus.CANCELLED },
        },
      },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  /** Create or replace the plan. Admin only, and the whole write surface. */
  async set(studentId: string, dto: SetInstallmentPlanDto, actor: Actor) {
    this.ensureAdmin(actor);
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { id: true, schoolId: true, fullName: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    this.enforceScope(actor, student.schoolId);

    const academicYear = await this.prisma.academicYear.findUnique({
      where: { id: dto.academicYearId },
      select: { id: true, schoolId: true, startDate: true, name: true },
    });
    if (!academicYear) throw new NotFoundException('Academic year not found');
    // Cross-tenant guard: an admin must not attach another school's year.
    if (academicYear.schoolId !== student.schoolId) {
      throw new BadRequestException('Invalid academic year for this school');
    }

    const school = await this.prisma.school.findUnique({
      where: { id: student.schoolId },
      select: { currency: true },
    });
    const rows = this.validateSchedule(
      dto,
      academicYear.startDate,
      school?.currency ?? 'PKR',
    );

    const existing = await this.prisma.feeInstallmentPlan.findUnique({
      where: {
        studentId_academicYearId: {
          studentId,
          academicYearId: dto.academicYearId,
        },
      },
      select: {
        id: true,
        totalAmount: true,
        isActive: true,
        installments: {
          orderBy: { seq: 'asc' },
          select: { seq: true, amount: true, dueDate: true },
        },
      },
    });

    const isActive = dto.isActive ?? true;
    const changed = this.differs(existing, dto.totalAmount, isActive, rows);

    // Re-shaping the schedule deletes and recreates its rows, which a challan
    // issued against one of them would forbid (Challan.installment is
    // Restrict). Refused here with an explanation rather than as a raw FK error
    // — and refusing is right: an invoiced schedule is no longer a draft.
    if (existing && changed) {
      const billed = await this.prisma.challan.findMany({
        where: { installmentPlanId: existing.id },
        orderBy: { installmentSeq: 'asc' },
        select: { installmentSeq: true, challanNo: true },
      });
      if (billed.length) {
        const list = billed
          .map((b) => `${b.installmentSeq} (${b.challanNo})`)
          .join(', ');
        throw new BadRequestException(
          `Installment ${list} has already been billed, so this schedule can no longer be changed. Cancel the challan first if it was issued in error.`,
        );
      }
    }

    // Replace in place, atomically — a half-applied schedule must never be
    // observable, and deleting the old rows is what keeps `seq` contiguous.
    await this.prisma.$transaction(async (tx) => {
      const plan = await tx.feeInstallmentPlan.upsert({
        where: {
          studentId_academicYearId: {
            studentId,
            academicYearId: dto.academicYearId,
          },
        },
        // The cadence columns are legacy and always null now — dates live on the
        // rows, which is the only place they were ever authoritative.
        create: {
          schoolId: student.schoolId,
          studentId,
          academicYearId: dto.academicYearId,
          totalAmount: dto.totalAmount,
          intervalUnit: null,
          intervalCount: null,
          startDate: utcMidnight(dto.startDate),
          isActive,
          createdByUserId: actor.userId,
        },
        update: {
          totalAmount: dto.totalAmount,
          intervalUnit: null,
          intervalCount: null,
          startDate: utcMidnight(dto.startDate),
          isActive,
        },
        select: { id: true },
      });

      await tx.feeInstallment.deleteMany({ where: { planId: plan.id } });
      await tx.feeInstallment.createMany({
        data: rows.map((r, i) => ({
          planId: plan.id,
          seq: i + 1,
          amount: r.amount,
          dueDate: r.dueDate,
        })),
      });
    });

    await this.invalidateFeeCache(student.schoolId);
    await this.audit.record(actor.userId, 'FEE_INSTALLMENT_PLAN_UPDATE', {
      schoolId: student.schoolId,
      entityType: 'StudentProfile',
      entityId: studentId,
      metadata: {
        academicYearId: dto.academicYearId,
        totalAmount: dto.totalAmount,
        installments: rows.length,
        isActive,
      },
    });

    // Only on a real change — an identical re-submission stays silent, which is
    // what stops a retried admission form from re-notifying.
    if (changed) {
      await notifyFeeAllocationUpdated(
        this.prisma,
        this.eventEmitter,
        studentId,
        student.fullName,
        isActive ? 'Installment plan updated' : 'Installment plan turned off',
        isActive
          ? `${student.fullName}'s fee is now scheduled as ${rows.length} installment${rows.length === 1 ? '' : 's'} totalling ${formatMinorUnits(dto.totalAmount, school?.currency ?? 'PKR')}.`
          : `${student.fullName}'s installment plan was switched off.`,
      );
    }

    return this.get(studentId, actor);
  }

  /**
   * Every rule the form mirrors — but this is the one that counts, since the
   * form is convenience and this is the guard.
   */
  private validateSchedule(
    dto: SetInstallmentPlanDto,
    yearStart: Date,
    currency: string,
  ): { amount: number; dueDate: Date }[] {
    const rows = dto.installments.map((r) => ({
      amount: r.amount,
      dueDate: utcMidnight(r.dueDate),
    }));

    const sum = rows.reduce((s, r) => s + r.amount, 0);
    if (sum !== dto.totalAmount) {
      const diff = Math.abs(dto.totalAmount - sum);
      throw new BadRequestException(
        `Installments total ${formatMinorUnits(sum, currency)} but the plan is ${formatMinorUnits(dto.totalAmount, currency)} — ${formatMinorUnits(diff, currency)} ${sum < dto.totalAmount ? 'short' : 'over'}.`,
      );
    }

    // Strictly ascending: the waterfall's order must be unambiguous.
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].dueDate.getTime() <= rows[i - 1].dueDate.getTime()) {
        throw new BadRequestException(
          `Installment ${i + 1} is due on or before installment ${i}. Due dates must run in order.`,
        );
      }
    }

    // A date before the session starts is a mistyped year, not a late plan.
    const yearStartDay = utcMidnight(yearStart).getTime();
    const tooEarly = rows.findIndex((r) => r.dueDate.getTime() < yearStartDay);
    if (tooEarly !== -1) {
      throw new BadRequestException(
        `Installment ${tooEarly + 1} is due before the academic year starts.`,
      );
    }

    return rows;
  }

  /** True when anything a reader would notice actually moved. */
  private differs(
    before: {
      totalAmount: number;
      isActive: boolean;
      installments: { seq: number; amount: number; dueDate: Date }[];
    } | null,
    totalAmount: number,
    isActive: boolean,
    rows: { amount: number; dueDate: Date }[],
  ): boolean {
    if (!before) return true;
    if (before.totalAmount !== totalAmount) return true;
    if (before.isActive !== isActive) return true;
    if (before.installments.length !== rows.length) return true;
    return rows.some((r, i) => {
      const prev = before.installments[i];
      return (
        prev.amount !== r.amount ||
        prev.dueDate.getTime() !== r.dueDate.getTime()
      );
    });
  }

  /**
   * The same object-level rule as `GET /fees/students/:id/challans` — student
   * on `userId`, parent on the `ParentStudent` link, teacher on section
   * membership. Editing the id in the URL is refused here, not by the UI.
   */
  private async assertReadable(
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

  private invalidateFeeCache(schoolId: string) {
    return (
      this.cache?.delByPrefix(feesCachePrefix(schoolId)) ?? Promise.resolve()
    );
  }
}
