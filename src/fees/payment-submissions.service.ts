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
import { S3PresignService } from '../common/services/s3-presign.service';
import { assertAttachmentAllowed } from '../common/upload/attachment-rules';
import { compressImage } from '../common/upload/image-compress';
import {
  NOTIFICATION_CREATE,
  type NotificationCreateEvent,
} from '../common/events/notification.events';
import {
  schoolAdminUserIds,
  studentAudienceUserIds,
} from '../common/notifications/recipients';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { remainingBalance } from './fee-calculator';
import {
  ChallanStatus,
  PaymentMethod,
  PaymentSubmissionStatus,
} from './fees.types';
import {
  CreatePaymentSubmissionDto,
  PaymentSubmissionQueryDto,
  RejectPaymentSubmissionDto,
} from './dto/payment-submission.dto';
import { PaymentsService } from './payments.service';
import { InstallmentPlansService } from './installment-plans.service';
import { feesCachePrefix } from './fees-cache';
import { formatMinorUnits } from './money.util';

/** Receipts are images or PDFs — the general attachment allow-list is wider. */
const RECEIPT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);

const utcMidnight = (value: string | Date): Date => {
  const d = new Date(value);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
};

type UploadedReceipt = {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size?: number;
};

/**
 * Online payment proof: submit -> review -> (verify | reject).
 *
 * **A submitted receipt is evidence, not money.** Nothing in this service
 * touches `Challan.paidAmount`. Verification delegates to the SAME
 * `PaymentsService.record()` every other payment goes through, so the ledger
 * re-sum, derived status, installment waterfall and audit trail are identical —
 * there is deliberately no second money path.
 */
@Injectable()
export class PaymentSubmissionsService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly s3: S3PresignService,
    private readonly payments: PaymentsService,
    private readonly installmentPlans: InstallmentPlansService,
  ) {
    super(prisma, cache);
  }

  // ==== Submit =============================================================

  /** Student or parent uploads proof against an unsettled challan. */
  async submit(
    challanId: string,
    dto: CreatePaymentSubmissionDto,
    file: UploadedReceipt | undefined,
    actor: Actor,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('A receipt file is required');
    }
    if (!RECEIPT_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        'The receipt must be a PNG, JPEG, WebP image or a PDF',
      );
    }
    // Size cap re-checked against the REAL buffer, not the declared size.
    assertAttachmentAllowed({
      mimeType: file.mimetype,
      sizeBytes: file.buffer.length,
    });

    const challan = await this.loadChallan(challanId);
    await this.assertCanSubmitFor(challan, actor);

    if (challan.status === ChallanStatus.CANCELLED) {
      throw new BadRequestException(
        'This challan is cancelled; payments cannot be submitted against it.',
      );
    }

    // Gate 1 of 2. The balance is re-checked again at verification, because it
    // can move in between (an admin recording cash, another proof verified).
    this.assertWithinBalance(dto.amount, challan, 'submit');

    // An installment student pays an INSTALLMENT, not a share of the year: the
    // row must be named and the amount must fit it.
    await this.assertInstallmentRules(dto, challan);

    // Store the bytes BEFORE the row, so a failed upload leaves no submission
    // pointing at a missing object. An orphaned object is the harmless side.
    const key = await this.s3.keyFor(
      challan.schoolId,
      'payment-receipts',
      actor.userId,
      file.originalname || 'receipt',
    );
    // Recompress an image receipt to KBs before storing (a PDF passes through).
    const { buffer: receiptBody, mimeType: receiptMime } = await compressImage(
      file.buffer,
      file.mimetype,
    );
    await this.s3.putObject({
      key,
      body: receiptBody,
      contentType: receiptMime ?? file.mimetype,
    });

    const submission = await this.prisma.paymentSubmission.create({
      data: {
        schoolId: challan.schoolId,
        challanId: challan.id,
        studentId: challan.studentId,
        installmentId: dto.installmentId ?? null,
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference?.trim() || null,
        paidAt: utcMidnight(dto.paidAt),
        note: dto.note?.trim() || null,
        receiptS3Key: key,
        receiptMimeType: receiptMime ?? file.mimetype,
        receiptSizeBytes: receiptBody.length,
        submittedByUserId: actor.userId,
        status: PaymentSubmissionStatus.PENDING_VERIFICATION,
      },
      select: this.listSelect(),
    });

    // The summary now reports a pending-verification count, so a new receipt
    // has to invalidate it — otherwise the dashboard under-reports the queue
    // for the length of the cache TTL.
    await this.invalidateFeeCache(challan.schoolId);
    await this.audit.record(actor.userId, 'FEE_PAYMENT_SUBMISSION_CREATE', {
      schoolId: challan.schoolId,
      entityType: 'PaymentSubmission',
      entityId: submission.id,
      metadata: {
        challanId: challan.id,
        challanNo: challan.challanNo,
        amount: dto.amount,
        method: dto.method,
      },
    });

    await this.notifyAdminsOfSubmission(challan, dto.amount);
    return submission;
  }

  // ==== Review =============================================================

  /**
   * Verify: create the real Payment through the existing workflow.
   *
   * Double-verification is blocked twice over — a conditional claim here, and
   * `PaymentSubmission.paymentId @unique` in the database as the backstop.
   */
  async verify(submissionId: string, actor: Actor) {
    this.ensureAdmin(actor);
    const submission = await this.loadForReview(submissionId, actor);

    const challan = await this.loadChallan(submission.challanId);
    // Gate 2 of 2: both the challan balance and the installment's own
    // remaining may have moved since the receipt was filed.
    this.assertWithinBalance(submission.amount, challan, 'verify');
    await this.assertInstallmentStillOwes(submission);

    // Claim the row: only a PENDING submission transitions, and only once. A
    // second concurrent verify updates 0 rows and stops here, before any money
    // is written.
    const claimed = await this.prisma.paymentSubmission.updateMany({
      where: {
        id: submissionId,
        status: PaymentSubmissionStatus.PENDING_VERIFICATION,
      },
      data: {
        status: PaymentSubmissionStatus.VERIFIED,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException(
        'This submission has already been reviewed.',
      );
    }

    let payment: { id: string };
    try {
      // The SAME path every other payment takes — notify:false because this
      // flow sends its own "verified" notice and two would be a duplicate.
      const result = await this.payments.record(
        submission.challanId,
        {
          amount: submission.amount,
          // Prisma's generated enum -> the local DTO enum, as elsewhere.
          method: submission.method as PaymentMethod,
          reference: submission.reference ?? undefined,
          paidAt: submission.paidAt.toISOString(),
          note: submission.note ?? undefined,
        },
        actor,
        { notify: false },
      );
      payment = result.payment;
    } catch (e) {
      // Money failed to record — release the claim so the queue still shows it
      // rather than stranding a VERIFIED submission with no Payment.
      await this.prisma.paymentSubmission.update({
        where: { id: submissionId },
        data: {
          status: PaymentSubmissionStatus.PENDING_VERIFICATION,
          reviewedByUserId: null,
          reviewedAt: null,
        },
      });
      throw e;
    }

    try {
      await this.prisma.paymentSubmission.update({
        where: { id: submissionId },
        data: { paymentId: payment.id },
      });
    } catch (e) {
      // The unique constraint firing here means another verify already linked a
      // payment — surfaced rather than swallowed.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException(
          'This submission has already produced a payment.',
        );
      }
      throw e;
    }

    await this.invalidateFeeCache(submission.schoolId);
    await this.audit.record(actor.userId, 'FEE_PAYMENT_SUBMISSION_VERIFY', {
      schoolId: submission.schoolId,
      entityType: 'PaymentSubmission',
      entityId: submissionId,
      metadata: {
        challanId: submission.challanId,
        challanNo: challan.challanNo,
        amount: submission.amount,
        paymentId: payment.id,
      },
    });

    await this.notifyReviewed(submission, challan.challanNo, true);
    return this.findOne(submissionId, actor);
  }

  /** Reject: mark it and tell the submitter. No Payment is created. */
  async reject(
    submissionId: string,
    dto: RejectPaymentSubmissionDto,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const submission = await this.loadForReview(submissionId, actor);

    const claimed = await this.prisma.paymentSubmission.updateMany({
      where: {
        id: submissionId,
        status: PaymentSubmissionStatus.PENDING_VERIFICATION,
      },
      data: {
        status: PaymentSubmissionStatus.REJECTED,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
        rejectionReason: dto.reason?.trim() || null,
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException(
        'This submission has already been reviewed.',
      );
    }

    const challan = await this.prisma.challan.findUniqueOrThrow({
      where: { id: submission.challanId },
      select: { challanNo: true },
    });

    // Leaves the queue, so the dashboard's pending count moves.
    await this.invalidateFeeCache(submission.schoolId);
    await this.audit.record(actor.userId, 'FEE_PAYMENT_SUBMISSION_REJECT', {
      schoolId: submission.schoolId,
      entityType: 'PaymentSubmission',
      entityId: submissionId,
      metadata: {
        challanId: submission.challanId,
        challanNo: challan.challanNo,
        amount: submission.amount,
        reason: dto.reason ?? null,
      },
    });

    await this.notifyReviewed(
      submission,
      challan.challanNo,
      false,
      dto.reason?.trim() || undefined,
    );
    return this.findOne(submissionId, actor);
  }

  // ==== Reads ==============================================================

  /** The admin verification queue. */
  async list(query: PaymentSubmissionQueryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);

    const submittedIn = this.submittedInRange(query.year, query.month);
    const where: Prisma.PaymentSubmissionWhereInput = {
      schoolId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...submittedIn,
    };

    const { skip, take, page, pageSize } = resolvePagination(query);
    const [total, items, pendingCount] = await Promise.all([
      this.prisma.paymentSubmission.count({ where }),
      this.prisma.paymentSubmission.findMany({
        where,
        // Oldest pending first — a verification queue is worked front to back.
        orderBy: { createdAt: 'asc' },
        skip,
        take,
        select: this.listSelect(),
      }),
      // Shares the date filter but NOT the status filter, so the Pending badge
      // always describes the period on screen — a badge of 3 beside an empty
      // list would just look broken.
      this.prisma.paymentSubmission.count({
        where: {
          schoolId,
          status: PaymentSubmissionStatus.PENDING_VERIFICATION,
          ...submittedIn,
        },
      }),
    ]);

    return {
      items: await this.withPlanContext(items),
      total,
      page,
      pageSize,
      pendingCount,
    };
  }

  /**
   * Tag each row with its student's plan, so the queue can say "installment 2
   * of 4" instead of leaving an admin to guess whether a part-payment is
   * correct. ONE query for the whole page — a per-row lookup here would be the
   * N+1 that a 20-row queue makes expensive.
   */
  private async withPlanContext<T extends { studentId: string }>(rows: T[]) {
    if (!rows.length) return rows.map((r) => ({ ...r, installmentPlan: null }));
    const byStudent = await this.installmentPlans.summariesFor(
      rows.map((r) => r.studentId),
    );
    return rows.map((r) => ({
      ...r,
      installmentPlan: byStudent.get(r.studentId) ?? null,
    }));
  }

  /**
   * Submission-date window. Built from UTC month boundaries rather than
   * `EXTRACT(...)` so the query stays index-friendly on `createdAt`.
   * A month without a year is ignored — it has no meaning on its own.
   */
  private submittedInRange(
    year?: number,
    month?: number,
  ): Prisma.PaymentSubmissionWhereInput {
    if (!year) return {};
    const from = month
      ? new Date(Date.UTC(year, month - 1, 1))
      : new Date(Date.UTC(year, 0, 1));
    const to = month
      ? new Date(Date.UTC(year, month, 1))
      : new Date(Date.UTC(year + 1, 0, 1));
    return { createdAt: { gte: from, lt: to } };
  }

  /** Submissions on one challan — object-level scoped for the portals. */
  async listForChallan(challanId: string, actor: Actor) {
    const challan = await this.loadChallan(challanId);
    await this.assertCanRead(challan, actor);
    const rows = await this.prisma.paymentSubmission.findMany({
      where: { challanId },
      orderBy: { createdAt: 'desc' },
      select: this.listSelect(),
    });
    return this.withPlanContext(rows);
  }

  async findOne(id: string, actor: Actor) {
    const submission = await this.prisma.paymentSubmission.findUnique({
      where: { id },
      select: this.listSelect(),
    });
    if (!submission) throw new NotFoundException('Submission not found');
    const challan = await this.loadChallan(submission.challanId);
    await this.assertCanRead(challan, actor);
    return (await this.withPlanContext([submission]))[0];
  }

  /**
   * Stream the receipt bytes. Never a public URL — the object is read through
   * the API so the same authorization applies to the file as to the record.
   */
  async receipt(id: string, actor: Actor) {
    const submission = await this.prisma.paymentSubmission.findUnique({
      where: { id },
      select: {
        id: true,
        challanId: true,
        receiptS3Key: true,
        receiptMimeType: true,
      },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    const challan = await this.loadChallan(submission.challanId);
    await this.assertCanRead(challan, actor);

    const data = await this.s3.getObjectBuffer(submission.receiptS3Key);
    return { data, mimeType: submission.receiptMimeType };
  }

  // ==== Helpers ============================================================

  private listSelect() {
    return {
      id: true,
      schoolId: true,
      challanId: true,
      studentId: true,
      installmentId: true,
      amount: true,
      method: true,
      reference: true,
      paidAt: true,
      note: true,
      receiptMimeType: true,
      receiptSizeBytes: true,
      status: true,
      rejectionReason: true,
      reviewedAt: true,
      paymentId: true,
      createdAt: true,
      student: { select: { id: true, fullName: true, rollNo: true } },
      challan: {
        select: {
          id: true,
          challanNo: true,
          netAmount: true,
          paidAmount: true,
          periodYear: true,
          periodMonth: true,
        },
      },
      // The row this receipt settles — the admin screen names it explicitly.
      installment: {
        select: { id: true, seq: true, amount: true, dueDate: true },
      },
      submittedBy: {
        select: { id: true, fullName: true, email: true, role: true },
      },
      reviewedBy: { select: { id: true, fullName: true, email: true } },
    } satisfies Prisma.PaymentSubmissionSelect;
  }

  private async loadChallan(challanId: string) {
    const challan = await this.prisma.challan.findUnique({
      where: { id: challanId },
      select: {
        id: true,
        schoolId: true,
        studentId: true,
        academicYearId: true,
        challanNo: true,
        netAmount: true,
        paidAmount: true,
        status: true,
        school: { select: { currency: true } },
      },
    });
    if (!challan) throw new NotFoundException('Challan not found');
    return { ...challan, status: challan.status as ChallanStatus };
  }

  /**
   * The claimed amount must fit the challan's REMAINING balance. Checked at
   * submission and again at verification — between the two, an admin may have
   * recorded cash or verified another proof, and crediting a stale claim would
   * overpay the challan.
   */
  private assertWithinBalance(
    amount: number,
    challan: {
      netAmount: number;
      paidAmount: number;
      school: { currency: string };
    },
    phase: 'submit' | 'verify',
  ) {
    const remaining = remainingBalance(challan.netAmount, challan.paidAmount);
    if (amount <= remaining) return;

    throw new BadRequestException(
      remaining === 0
        ? phase === 'verify'
          ? 'This challan was settled after the receipt was submitted, so there is nothing left to verify.'
          : 'This challan is already settled in full.'
        : phase === 'verify'
          ? `The remaining balance is now ${formatMinorUnits(remaining, challan.school.currency)}, less than the ${formatMinorUnits(amount, challan.school.currency)} claimed. Reject this submission and ask for a corrected amount.`
          : `Amount exceeds the remaining balance of ${formatMinorUnits(remaining, challan.school.currency)}.`,
    );
  }

  /**
   * The installment contract, and the reason this service knows about plans at
   * all.
   *
   * For a student on an ACTIVE plan a receipt must name the installment it
   * settles, and it must be the one the waterfall would credit — otherwise the
   * portal would show a family "paying installment 3" while the money lands on
   * installment 1. The cap is the installment's own remaining, not the year's.
   *
   * A student with no plan is untouched: `installmentId` stays optional and
   * nothing below runs. That is what keeps the normal challan flow intact.
   */
  private async assertInstallmentRules(
    dto: { amount: number; installmentId?: string },
    challan: { studentId: string; academicYearId: string },
  ) {
    const plan = await this.installmentPlans.loadPlan(
      challan.studentId,
      challan.academicYearId,
    );

    if (!plan?.isActive) {
      // No plan: the installment link is meaningless, so refuse a stray one
      // rather than storing a pointer nothing will ever honour.
      if (dto.installmentId) {
        throw new BadRequestException(
          'This student is not on an installment plan, so a payment cannot be attached to an installment.',
        );
      }
      return;
    }

    if (!plan.payable) {
      throw new BadRequestException(
        plan.payableBlockedReason ??
          'This installment plan is already paid in full.',
      );
    }

    const { installment, maxAmount } = plan.payable;

    if (!dto.installmentId) {
      throw new BadRequestException(
        `This student pays by installment — choose the installment this receipt is for. Installment ${installment.seq} is the one currently due.`,
      );
    }

    if (dto.installmentId !== installment.id) {
      throw new BadRequestException(
        `Installments are settled in order, so installment ${installment.seq} has to be paid first.`,
      );
    }

    if (dto.amount > maxAmount) {
      throw new BadRequestException(
        `Installment ${installment.seq} has ${formatMinorUnits(maxAmount, 'PKR')} remaining, which is less than the amount claimed.`,
      );
    }
  }

  /**
   * Re-check at verification: the installment's remaining is derived from the
   * ledger, so a cash payment or another verified receipt in the meantime may
   * have settled it. Without this, two receipts for one installment would both
   * credit. A stale link (plan edited since) falls back to the challan check.
   */
  private async assertInstallmentStillOwes(submission: {
    studentId: string;
    installmentId: string | null;
    amount: number;
  }) {
    if (!submission.installmentId) return;

    const row = await this.installmentPlans.remainingOnInstallment(
      submission.studentId,
      submission.installmentId,
    );
    if (!row) return;

    if (submission.amount > row.remainingAmount) {
      throw new BadRequestException(
        row.remainingAmount === 0
          ? `Installment ${row.seq} was settled after this receipt was submitted, so there is nothing left to verify.`
          : `Installment ${row.seq} now has less outstanding than this receipt claims. Reject it and ask for a corrected amount.`,
      );
    }
  }

  /** Loads a submission for review and pins it to the actor's tenant. */
  private async loadForReview(id: string, actor: Actor) {
    const submission = await this.prisma.paymentSubmission.findUnique({
      where: { id },
      select: {
        id: true,
        schoolId: true,
        challanId: true,
        studentId: true,
        installmentId: true,
        amount: true,
        method: true,
        reference: true,
        paidAt: true,
        note: true,
        status: true,
        submittedByUserId: true,
      },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    this.enforceScope(actor, submission.schoolId);
    return submission;
  }

  /**
   * Who may submit: the student themselves, or a parent linked to them. The
   * ParentStudent link IS the rule, so a parent can never submit for a child
   * that isn't theirs.
   */
  private async assertCanSubmitFor(
    challan: { schoolId: string; studentId: string },
    actor: Actor,
  ) {
    if (actor.schoolId !== challan.schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }

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

  /** Read access: admins in-tenant, plus the student and their guardians. */
  private async assertCanRead(
    challan: { schoolId: string; studentId: string },
    actor: Actor,
  ) {
    if (actor.role === Role.SUPER_ADMIN) return;
    if (actor.schoolId !== challan.schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
    if (actor.role === Role.SCHOOL_ADMIN) return;
    await this.assertCanSubmitFor(challan, actor);
  }

  // ==== Notifications ======================================================

  /** Tell the school's admins that a receipt is waiting for review. */
  private async notifyAdminsOfSubmission(
    challan: { schoolId: string; id: string; challanNo: string },
    amount: number,
  ) {
    const [admins, student, currency] = await Promise.all([
      schoolAdminUserIds(this.prisma, challan.schoolId),
      this.prisma.studentProfile.findFirst({
        where: { challans: { some: { id: challan.id } } },
        select: { fullName: true },
      }),
      this.prisma.school
        .findUnique({
          where: { id: challan.schoolId },
          select: { currency: true },
        })
        .then((s) => s?.currency ?? 'PKR'),
    ]);
    if (!admins.length) return;

    this.eventEmitter.emit(NOTIFICATION_CREATE, {
      userIds: admins,
      type: 'FEE_PAYMENT_SUBMITTED',
      title: 'Payment proof needs verification',
      body: `${student?.fullName ?? 'A student'} submitted a receipt of ${formatMinorUnits(amount, currency)} for challan ${challan.challanNo}. It is not credited until you verify it.`,
      link: '/fees/verifications',
      entityType: 'PaymentSubmission',
      entityId: challan.id,
      notifyPreferenceKey: 'notifyGrades',
    } as NotificationCreateEvent);
  }

  /**
   * Verified -> the student AND their guardians hear it (the money is theirs
   * collectively). Rejected -> only the person who submitted it, since a
   * rejection is feedback on their action.
   */
  private async notifyReviewed(
    submission: {
      studentId: string;
      challanId: string;
      amount: number;
      schoolId: string;
      submittedByUserId: string;
    },
    challanNo: string,
    verified: boolean,
    reason?: string,
  ) {
    const currency =
      (
        await this.prisma.school.findUnique({
          where: { id: submission.schoolId },
          select: { currency: true },
        })
      )?.currency ?? 'PKR';
    const money = formatMinorUnits(submission.amount, currency);

    const userIds = verified
      ? await studentAudienceUserIds(this.prisma, submission.studentId)
      : [submission.submittedByUserId];
    if (!userIds.length) return;

    this.eventEmitter.emit(NOTIFICATION_CREATE, {
      userIds,
      type: verified ? 'FEE_PAYMENT_VERIFIED' : 'FEE_PAYMENT_REJECTED',
      title: verified ? 'Payment verified' : 'Payment proof rejected',
      body: verified
        ? `The payment of ${money} submitted for challan ${challanNo} has been verified and credited.`
        : `The payment proof of ${money} submitted for challan ${challanNo} was rejected.${reason ? ` Reason: ${reason}` : ''}`,
      link: `/fees/${submission.challanId}`,
      entityType: 'Challan',
      entityId: submission.challanId,
      notifyPreferenceKey: 'notifyGrades',
    } as NotificationCreateEvent);
  }

  private invalidateFeeCache(schoolId: string) {
    return (
      this.cache?.delByPrefix(feesCachePrefix(schoolId)) ?? Promise.resolve()
    );
  }
}
