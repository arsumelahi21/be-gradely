import {
  BadRequestException,
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
  NOTIFICATION_CREATE,
  type NotificationCreateEvent,
} from '../common/events/notification.events';
import { studentAudienceUserIds } from '../common/notifications/recipients';
import { Actor } from '../common/types/actor.type';
import { remainingBalance, resolveChallanStatus } from './fee-calculator';
import { ChallanStatus } from './fees.types';
import {
  CancelChallanDto,
  RecordPaymentDto,
  VoidPaymentDto,
} from './dto/record-payment.dto';
import { feesCachePrefix } from './fees-cache';
import { formatMinorUnits } from './money.util';

@Injectable()
export class PaymentsService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, cache);
  }

  /**
   * Record a receipt. Insert, re-sum the ledger, write `paidAmount` and derive
   * status — all in ONE transaction.
   *
   * `options.notify` exists for the payment-verification path: verifying a
   * submitted receipt sends its OWN "your payment was verified" notice, and
   * emitting the generic receipt notice as well would be two notifications for
   * one event. Defaults to true, so every existing caller is unaffected.
   */
  async record(
    challanId: string,
    dto: RecordPaymentDto,
    actor: Actor,
    options: { notify?: boolean } = {},
  ) {
    const challan = await this.getChallanForWrite(challanId, actor);

    const result = await this.prisma.$transaction(async (tx) => {
      // Checked under the row lock: checked before it, two receipts at once
      // could each fit the same balance and together overpay.
      const current = await this.lockChallan(tx, challanId);
      if (current.status === ChallanStatus.CANCELLED) {
        throw new BadRequestException(
          'This challan is cancelled; payments cannot be recorded against it.',
        );
      }
      const remaining = remainingBalance(current.netAmount, current.paidAmount);
      if (dto.amount > remaining) {
        throw new BadRequestException(
          remaining === 0
            ? 'This challan is already settled in full.'
            : `Payment exceeds the remaining balance of ${formatMinorUnits(remaining, challan.school.currency)}.`,
        );
      }

      const payment = await tx.payment.create({
        data: {
          challanId,
          schoolId: challan.schoolId,
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference?.trim() || null,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          recordedByUserId: actor.userId,
          note: dto.note?.trim() || null,
        },
      });
      const updated = await this.resettle(tx, challanId, current.netAmount);
      return { payment, challan: updated };
    });

    await this.invalidateFeeCache(challan.schoolId);
    await this.audit.record(actor.userId, 'FEE_PAYMENT_RECORD', {
      schoolId: challan.schoolId,
      entityType: 'Payment',
      entityId: result.payment.id,
      metadata: {
        challanId,
        challanNo: challan.challanNo,
        amount: dto.amount,
        method: dto.method,
      },
    });
    if (options.notify !== false) {
      await this.notifyPaymentReceived(
        challan.studentId,
        challanId,
        challan.challanNo,
        dto.amount,
        challan.school.currency,
      );
    }

    return result;
  }

  private async notifyPaymentReceived(
    studentId: string,
    challanId: string,
    challanNo: string,
    amount: number,
    currency: string,
  ) {
    // The ParentStudent link IS the rule — a parent only ever appears here for
    // a child they're linked to, and every recipient is inside one school.
    const userIds = await studentAudienceUserIds(this.prisma, studentId);
    if (!userIds.length) return;

    this.eventEmitter.emit(NOTIFICATION_CREATE, {
      userIds,
      type: 'FEE_PAYMENT_RECEIVED',
      title: 'Fee payment received',
      body: `A payment of ${formatMinorUnits(amount, currency)} was recorded against challan ${challanNo}.`,
      // Portal-relative; the bell prefixes the viewer's own dashboard.
      link: `/fees/${challanId}`,
      entityType: 'Challan',
      entityId: challanId,
      notifyPreferenceKey: 'notifyGrades',
    } as NotificationCreateEvent);
  }

  /**
   * Void a receipt. The row is never deleted and its amount is never edited —
   * the tombstone drops it from the re-sum, so the ledger stays reconstructible.
   */
  async void(paymentId: string, dto: VoidPaymentDto, actor: Actor) {
    this.ensureAdmin(actor);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        schoolId: true,
        challanId: true,
        amount: true,
        voidedAt: true,
        challan: { select: { netAmount: true, challanNo: true } },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    this.enforceScope(actor, payment.schoolId);
    if (payment.voidedAt) {
      throw new BadRequestException('This payment is already voided.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockChallan(tx, payment.challanId);
      // Claimed, not updated: the check above read the row before the lock, so
      // two concurrent voids both pass it and the audit trail would name the
      // loser as the one who voided.
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, voidedAt: null },
        data: {
          voidedAt: new Date(),
          voidedByUserId: actor.userId,
          voidReason: dto.reason?.trim() || null,
        },
      });
      if (!claimed.count) {
        throw new BadRequestException('This payment is already voided.');
      }
      return this.resettle(tx, payment.challanId, locked.netAmount);
    });

    await this.invalidateFeeCache(payment.schoolId);
    await this.audit.record(actor.userId, 'FEE_PAYMENT_VOID', {
      schoolId: payment.schoolId,
      entityType: 'Payment',
      entityId: paymentId,
      metadata: {
        challanId: payment.challanId,
        challanNo: payment.challan.challanNo,
        amount: payment.amount,
        reason: dto.reason ?? null,
      },
    });

    return result;
  }

  /**
   * Void a challan. Never a hard delete — financial history must survive.
   *
   * The challans it absorbed as arrears are reopened, or cancelling it would
   * erase that debt. Generation only ever carries unpaid ones, so they go back
   * to UNPAID.
   */
  async cancelChallan(challanId: string, dto: CancelChallanDto, actor: Actor) {
    const challan = await this.getChallanForWrite(challanId, actor);

    const { updated, reopened } = await this.prisma.$transaction(async (tx) => {
      // Under the lock, so a payment can't land between the check and the cancel.
      const current = await this.lockChallan(tx, challanId);
      if (current.status === ChallanStatus.CANCELLED) {
        throw new BadRequestException('This challan is already cancelled.');
      }

      // Cancelling with live receipts attached would strand real money, so the
      // payments must be voided first — deliberately explicit, not automatic.
      const livePayments = await tx.payment.count({
        where: { challanId, voidedAt: null },
      });
      if (livePayments > 0) {
        throw new BadRequestException(
          `This challan has ${livePayments} recorded payment(s). Void them first, then cancel.`,
        );
      }

      const updated = await tx.challan.update({
        where: { id: challanId },
        data: {
          status: ChallanStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: dto.reason?.trim() || null,
        },
      });
      // ponytail: linked by the cancelReason generation writes, the only link
      // stored; add a supersededById column if it ever needs to be exact.
      const carried = await tx.challan.findMany({
        where: {
          schoolId: challan.schoolId,
          studentId: challan.studentId,
          status: ChallanStatus.CANCELLED,
          cancelReason: `Carried forward to ${challan.challanNo}`,
        },
        select: { id: true, challanNo: true },
      });
      if (carried.length) {
        await tx.challan.updateMany({
          where: { id: { in: carried.map((c) => c.id) } },
          data: {
            status: ChallanStatus.UNPAID,
            cancelledAt: null,
            cancelReason: null,
          },
        });
      }
      return { updated, reopened: carried.map((c) => c.challanNo) };
    });

    await this.invalidateFeeCache(challan.schoolId);
    await this.audit.record(actor.userId, 'FEE_CHALLAN_CANCEL', {
      schoolId: challan.schoolId,
      entityType: 'Challan',
      entityId: challanId,
      metadata: {
        challanNo: challan.challanNo,
        reason: dto.reason ?? null,
        reopened,
      },
    });

    return { ...updated, reopenedChallanNos: reopened };
  }

  /** Receipts for a challan, newest first. Voided rows are kept and flagged. */
  async listForChallan(challanId: string, actor: Actor) {
    const challan = await this.getChallanForWrite(challanId, actor);
    return this.prisma.payment.findMany({
      where: { challanId: challan.id },
      orderBy: { paidAt: 'desc' },
      select: {
        id: true,
        amount: true,
        method: true,
        reference: true,
        paidAt: true,
        note: true,
        voidedAt: true,
        voidReason: true,
        createdAt: true,
        recordedBy: { select: { id: true, fullName: true, email: true } },
        voidedBy: { select: { id: true, fullName: true, email: true } },
      },
    });
  }

  /**
   * Recompute `paidAmount` from the ledger rather than incrementing it, so the
   * denormalized total is always reconstructible from the receipts.
   */
  private async resettle(
    tx: Prisma.TransactionClient,
    challanId: string,
    netAmount: number,
  ) {
    const agg = await tx.payment.aggregate({
      where: { challanId, voidedAt: null },
      _sum: { amount: true },
    });
    const paidAmount = agg._sum.amount ?? 0;
    return tx.challan.update({
      where: { id: challanId },
      data: { paidAmount, status: resolveChallanStatus(paidAmount, netAmount) },
    });
  }

  /** Locks the challan row until the transaction ends and reads it fresh. */
  private async lockChallan(tx: Prisma.TransactionClient, challanId: string) {
    const [row] = await tx.$queryRaw<
      { status: ChallanStatus; netAmount: number; paidAmount: number }[]
    >`SELECT status, "netAmount", "paidAmount" FROM "Challan" WHERE id = ${challanId} FOR UPDATE`;
    if (!row) throw new NotFoundException('Challan not found');
    return row;
  }

  private async getChallanForWrite(challanId: string, actor: Actor) {
    this.ensureAdmin(actor);
    const challan = await this.prisma.challan.findUnique({
      where: { id: challanId },
      select: {
        id: true,
        schoolId: true,
        studentId: true,
        challanNo: true,
        netAmount: true,
        paidAmount: true,
        status: true,
        school: { select: { currency: true } },
      },
    });
    if (!challan) throw new NotFoundException('Challan not found');
    this.enforceScope(actor, challan.schoolId);
    return { ...challan, status: challan.status as ChallanStatus };
  }

  private invalidateFeeCache(schoolId: string) {
    return (
      this.cache?.delByPrefix(feesCachePrefix(schoolId)) ?? Promise.resolve()
    );
  }
}
