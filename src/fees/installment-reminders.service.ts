import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import {
  NOTIFICATION_CREATE_BATCH,
  type NotificationCreateBatchEvent,
} from '../common/events/notification.events';
import {
  parentUserIdsByStudent,
  studentUserIdByStudent,
} from '../common/notifications/recipients';
import { allocateInstallments } from './fee-calculator';
import { ChallanStatus } from './fees.types';
import { formatMinorUnits } from './money.util';

const utcMidnight = (value: Date): Date =>
  new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );

const addDays = (d: Date, days: number): Date =>
  new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days),
  );

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface ReminderSweepResult {
  reminded: number;
  schools: number;
}

/**
 * Sends "your installment is due soon" to each student and their guardians.
 *
 * This is the module's first UNATTENDED writer — no actor, no request — so its
 * tenancy comes entirely from the query shape: recipients resolve through
 * `ParentStudent`, which is itself the authorization rule, and every
 * installment reaches a student who belongs to exactly one school.
 *
 * The whole sweep is a CONSTANT number of queries no matter how many students
 * are reminded; the announcements scheduler's per-row claim would be the N+1
 * this has to avoid at scale.
 */
@Injectable()
export class InstallmentRemindersService {
  private readonly logger = new Logger(InstallmentRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async sweep(now: Date = new Date()): Promise<ReminderSweepResult> {
    const today = utcMidnight(now);

    // 1. Schools that want reminders, with their own window width.
    const schools = await this.prisma.school.findMany({
      where: { installmentReminderEnabled: true },
      select: {
        id: true,
        currency: true,
        installmentReminderDaysBefore: true,
      },
    });
    if (!schools.length) return { reminded: 0, schools: 0 };

    const bySchool = new Map(schools.map((s) => [s.id, s]));
    const widest = Math.max(
      ...schools.map((s) => Math.max(0, s.installmentReminderDaysBefore)),
    );

    // 2. One query over the WIDEST window, then narrow per school in memory —
    //    a query per school would scale with tenants for no benefit.
    //
    //    `dueDate >= today` skips anything already past due; `<=` (rather than
    //    an exact date match) means a sweep missed to downtime catches up on
    //    the next run instead of silently dropping a day's reminders.
    const candidates = await this.prisma.feeInstallment.findMany({
      where: {
        reminderSentAt: null,
        dueDate: { gte: today, lte: addDays(today, widest) },
        plan: { isActive: true, schoolId: { in: [...bySchool.keys()] } },
      },
      select: {
        id: true,
        seq: true,
        amount: true,
        dueDate: true,
        planId: true,
        plan: {
          select: {
            schoolId: true,
            studentId: true,
            academicYearId: true,
            student: { select: { fullName: true } },
          },
        },
      },
    });

    const inWindow = candidates.filter((c) => {
      const school = bySchool.get(c.plan.schoolId);
      if (!school) return false;
      const days = Math.max(0, school.installmentReminderDaysBefore);
      return c.dueDate.getTime() <= addDays(today, days).getTime();
    });
    if (!inWindow.length) return { reminded: 0, schools: schools.length };

    // 3. ALL installments of the affected plans — the waterfall cannot be
    //    computed from the due-soon subset alone.
    const planIds = [...new Set(inWindow.map((c) => c.planId))];
    const siblings = await this.prisma.feeInstallment.findMany({
      where: { planId: { in: planIds } },
      select: {
        id: true,
        seq: true,
        amount: true,
        dueDate: true,
        planId: true,
      },
    });
    const byPlan = new Map<string, typeof siblings>();
    for (const row of siblings) {
      byPlan.set(row.planId, [...(byPlan.get(row.planId) ?? []), row]);
    }

    // 4. The payment pools, one query for every (student, year) pair at once.
    const pools = await this.paidPools(
      inWindow.map((c) => ({
        studentId: c.plan.studentId,
        academicYearId: c.plan.academicYearId,
      })),
    );

    // Skip anything the waterfall has already settled — an installment paid
    // ahead of time should not be chased.
    const unpaid = inWindow.filter((c) => {
      const all = byPlan.get(c.planId) ?? [];
      const pool =
        pools.get(`${c.plan.studentId}:${c.plan.academicYearId}`) ?? 0;
      const allocated = allocateInstallments(all, pool, today);
      return (allocated.find((a) => a.id === c.id)?.remainingAmount ?? 0) > 0;
    });
    if (!unpaid.length) return { reminded: 0, schools: schools.length };

    // 5+6. Claim in bulk, then learn which rows THIS run won. Two overlapping
    //      sweeps carry different `runAt` stamps, so neither double-sends.
    //      Claiming BEFORE notifying means a crash loses a reminder rather
    //      than repeating one — the right way round for a parent's phone.
    const runAt = new Date(now.getTime());
    const ids = unpaid.map((c) => c.id);
    await this.prisma.feeInstallment.updateMany({
      where: { id: { in: ids }, reminderSentAt: null },
      data: { reminderSentAt: runAt },
    });
    const claimed = await this.prisma.feeInstallment.findMany({
      where: { id: { in: ids }, reminderSentAt: runAt },
      select: { id: true },
    });
    const claimedIds = new Set(claimed.map((c) => c.id));
    const toSend = unpaid.filter((c) => claimedIds.has(c.id));
    if (!toSend.length) return { reminded: 0, schools: schools.length };

    await this.emit(toSend, byPlan, bySchool);
    return { reminded: toSend.length, schools: schools.length };
  }

  /**
   * Non-voided payments on non-cancelled challans, grouped by (student, year).
   * One `groupBy` for every pair rather than a query per student.
   */
  private async paidPools(
    pairs: { studentId: string; academicYearId: string }[],
  ): Promise<Map<string, number>> {
    if (!pairs.length) return new Map();
    const studentIds = [...new Set(pairs.map((p) => p.studentId))];
    const yearIds = [...new Set(pairs.map((p) => p.academicYearId))];

    const rows = await this.prisma.payment.findMany({
      where: {
        voidedAt: null,
        challan: {
          studentId: { in: studentIds },
          academicYearId: { in: yearIds },
          status: { not: ChallanStatus.CANCELLED },
        },
      },
      select: {
        amount: true,
        challan: { select: { studentId: true, academicYearId: true } },
      },
    });

    const pools = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.challan.studentId}:${r.challan.academicYearId}`;
      pools.set(key, (pools.get(key) ?? 0) + r.amount);
    }
    return pools;
  }

  /** 7+8: recipients in two queries, then ONE batched event for everyone. */
  private async emit(
    toSend: {
      id: string;
      seq: number;
      amount: number;
      dueDate: Date;
      planId: string;
      plan: {
        schoolId: string;
        studentId: string;
        student: { fullName: string };
      };
    }[],
    byPlan: Map<string, { planId: string }[]>,
    bySchool: Map<string, { currency: string }>,
  ) {
    const studentIds = [...new Set(toSend.map((c) => c.plan.studentId))];
    const [selfByStudent, parentsByStudent] = await Promise.all([
      studentUserIdByStudent(this.prisma, studentIds),
      parentUserIdsByStudent(this.prisma, studentIds),
    ]);

    const items = toSend
      .map((c) => {
        const self = selfByStudent.get(c.plan.studentId);
        const userIds = [
          ...new Set([
            ...(self ? [self] : []),
            ...(parentsByStudent.get(c.plan.studentId) ?? []),
          ]),
        ];
        const total = byPlan.get(c.planId)?.length ?? 0;
        const currency = bySchool.get(c.plan.schoolId)?.currency ?? 'PKR';
        return {
          userIds,
          title: 'Installment due soon',
          body: `${c.plan.student.fullName} — installment ${c.seq} of ${total} (${formatMinorUnits(c.amount, currency)}) is due on ${isoDay(c.dueDate)}.`,
          // Portal-relative: the bell prefixes the viewer's own dashboard.
          link: '/fees',
          entityType: 'FeeInstallment',
          entityId: c.id,
        };
      })
      // A student with no login and no linked guardian has no one to tell.
      .filter((i) => i.userIds.length);

    if (!items.length) return;

    this.eventEmitter.emit(NOTIFICATION_CREATE_BATCH, {
      type: 'FEE_INSTALLMENT_DUE_SOON',
      notifyPreferenceKey: 'notifyGrades',
      items,
    } as NotificationCreateBatchEvent);

    this.logger.log(`Reminded ${items.length} upcoming installment(s)`);
  }
}
