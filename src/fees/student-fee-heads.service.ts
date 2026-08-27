import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { CacheService } from '../common/services/cache.service';
import { AuditLogService } from '../audit/audit.service';
import { Actor } from '../common/types/actor.type';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SetStudentFeeHeadsDto } from './dto/student-fee-heads.dto';
import { notifyFeeAllocationUpdated } from './fee-notifications';
import { feesCachePrefix } from './fees-cache';

/**
 * One student's fee heads. An override is a per-student row — it never touches
 * `FeeHead`, so editing a student here cannot move the school-wide default or
 * any other student's bill.
 *
 * Past challans are unaffected by construction: `ChallanItem` copies label and
 * amount at generation, so an override changed later only reaches the NEXT
 * challan.
 */
@Injectable()
export class StudentFeeHeadsService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, cache);
  }

  /** The student's effective heads: school defaults with their overrides applied. */
  async list(studentId: string, actor: Actor) {
    const student = await this.getStudentOrThrow(studentId, actor);

    const [heads, overrides, school] = await Promise.all([
      this.prisma.feeHead.findMany({
        where: { schoolId: student.schoolId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, defaultAmount: true },
      }),
      this.prisma.studentFeeHeadOverride.findMany({
        where: { studentId },
        select: { feeHeadId: true, amount: true, isExcluded: true },
      }),
      this.prisma.school.findUnique({
        where: { id: student.schoolId },
        select: { currency: true },
      }),
    ]);

    const byHeadId = new Map(overrides.map((o) => [o.feeHeadId, o]));

    return {
      currency: school?.currency ?? 'PKR',
      student: {
        id: student.id,
        fullName: student.fullName,
        monthlyFeeAmount: student.monthlyFeeAmount,
      },
      heads: heads.map((h) => {
        const override = byHeadId.get(h.id);
        return {
          feeHeadId: h.id,
          name: h.name,
          defaultAmount: h.defaultAmount,
          // What this student is actually billed for the head.
          amount:
            override && !override.isExcluded
              ? override.amount
              : h.defaultAmount,
          isExcluded: override?.isExcluded ?? false,
          isOverridden: !!override,
        };
      }),
    };
  }

  /**
   * Replace the student's overrides. A head absent from `overrides` reverts to
   * the school default — that's how "reset" is expressed.
   */
  async set(studentId: string, dto: SetStudentFeeHeadsDto, actor: Actor) {
    const student = await this.getStudentOrThrow(studentId, actor);

    const incoming = dto.overrides ?? [];
    const uniqueIds = new Set(incoming.map((o) => o.feeHeadId));
    if (uniqueIds.size !== incoming.length) {
      throw new BadRequestException('Duplicate fee head in the request');
    }

    // Every head must belong to this student's school — otherwise an admin
    // could attach another tenant's head to their student.
    if (uniqueIds.size) {
      const owned = await this.prisma.feeHead.count({
        where: { id: { in: [...uniqueIds] }, schoolId: student.schoolId },
      });
      if (owned !== uniqueIds.size) {
        throw new BadRequestException('Invalid fee head for this school');
      }
    }

    // Compare against what's stored so a re-submitted, identical save is a
    // no-op — that's what stops a retry from re-notifying.
    const before = await this.prisma.studentFeeHeadOverride.findMany({
      where: { studentId },
      select: { feeHeadId: true, amount: true, isExcluded: true },
    });
    const changed = this.differs(before, incoming);

    // Replace-in-place, atomically: a partial write would leave the student
    // billed from a half-applied configuration.
    await this.prisma.$transaction(async (tx) => {
      await tx.studentFeeHeadOverride.deleteMany({ where: { studentId } });
      if (incoming.length) {
        await tx.studentFeeHeadOverride.createMany({
          data: incoming.map((o) => ({
            studentId,
            feeHeadId: o.feeHeadId,
            amount: o.amount,
            isExcluded: o.isExcluded ?? false,
          })),
        });
      }
    });

    await this.invalidateFeeCache(student.schoolId);
    await this.audit.record(actor.userId, 'FEE_STUDENT_HEADS_UPDATE', {
      schoolId: student.schoolId,
      entityType: 'StudentProfile',
      entityId: studentId,
      metadata: { overrides: incoming.length },
    });

    if (changed) {
      await notifyFeeAllocationUpdated(
        this.prisma,
        this.eventEmitter,
        studentId,
        student.fullName,
        'Fee heads updated',
        `${student.fullName}'s individual fee heads were updated. Open Fees to see the amounts that will apply to the next challan.`,
      );
    }

    return this.list(studentId, actor);
  }

  /** Set-equality on (feeHeadId, amount, isExcluded) — order doesn't matter. */
  private differs(
    before: { feeHeadId: string; amount: number; isExcluded: boolean }[],
    after: { feeHeadId: string; amount: number; isExcluded?: boolean }[],
  ): boolean {
    if (before.length !== after.length) return true;
    const key = (o: {
      feeHeadId: string;
      amount: number;
      isExcluded?: boolean;
    }) => `${o.feeHeadId}:${o.isExcluded ? 'x' : o.amount}`;
    const beforeKeys = new Set(before.map(key));
    return after.some((o) => !beforeKeys.has(key(o)));
  }

  private async getStudentOrThrow(studentId: string, actor: Actor) {
    this.ensureAdmin(actor);
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        schoolId: true,
        fullName: true,
        monthlyFeeAmount: true,
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    this.enforceScope(actor, student.schoolId);
    return student;
  }

  private invalidateFeeCache(schoolId: string) {
    return (
      this.cache?.delByPrefix(feesCachePrefix(schoolId)) ?? Promise.resolve()
    );
  }
}
