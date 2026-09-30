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
import { SetSubjectFeesDto } from './dto/subject-fees.dto';

/** The key a fee is stored under: "e123 " and "E123" are one code. */
export const normalizeSubjectCode = (code: string | null | undefined) =>
  code?.trim().toUpperCase() || null;

/**
 * One monthly fee per subject code, school-wide: every subject with the code,
 * in any class, is billed it. Only the next generated challan reads it — an
 * issued challan keeps the amount it was generated with.
 */
@Injectable()
export class SubjectFeesService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly audit: AuditLogService,
  ) {
    super(prisma, cache);
  }

  /**
   * Each code once, with the subject names using it and its fee (null = not
   * set). A fee whose code no subject uses any more is listed too, so it can
   * be cleared; subjects without a code can't carry a fee and are listed apart.
   */
  async list(actor: Actor, schoolId?: string) {
    this.ensureAdmin(actor);
    const sid = this.resolveSchoolId(actor, schoolId);
    const [subjects, fees] = await Promise.all([
      this.prisma.subject.findMany({
        where: { schoolId: sid },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true },
      }),
      this.prisma.subjectFee.findMany({
        where: { schoolId: sid },
        select: { code: true, amount: true },
      }),
    ]);
    const namesOf = new Map<string, Set<string>>();
    const withoutCode: { subjectId: string; name: string }[] = [];
    for (const s of subjects) {
      const code = normalizeSubjectCode(s.code);
      if (!code) withoutCode.push({ subjectId: s.id, name: s.name });
      else namesOf.set(code, (namesOf.get(code) ?? new Set()).add(s.name));
    }
    const feeOf = new Map(fees.map((f) => [f.code, f.amount]));
    const codes = [...new Set([...namesOf.keys(), ...feeOf.keys()])].sort();
    return {
      codes: codes.map((code) => ({
        code,
        names: [...(namesOf.get(code) ?? [])],
        amount: feeOf.get(code) ?? null,
      })),
      withoutCode,
    };
  }

  /** Sets the listed codes' fees; a null amount clears one. Others are untouched. */
  async set(dto: SetSubjectFeesDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    const items = dto.items.map((i) => ({
      code: normalizeSubjectCode(i.code)!,
      amount: i.amount,
    }));
    const codes = [...new Set(items.map((i) => i.code))];
    if (codes.length !== items.length) {
      throw new BadRequestException('Each subject code can only be set once');
    }
    // A code is settable while a subject uses it, or while a fee exists for it
    // (so an orphaned fee can still be cleared).
    const { codes: known } = await this.list(actor, schoolId);
    const knownCodes = new Set(known.map((k) => k.code));
    const unknown = codes.filter((c) => !knownCodes.has(c));
    if (unknown.length) {
      throw new NotFoundException(
        `No subject has the code ${unknown.join(', ')}`,
      );
    }

    const changes = await this.prisma.$transaction(async (tx) => {
      const before = new Map(
        (
          await tx.subjectFee.findMany({
            where: { schoolId, code: { in: codes } },
            select: { code: true, amount: true },
          })
        ).map((f) => [f.code, f.amount]),
      );
      const changed = items.filter(
        (i) => (before.get(i.code) ?? null) !== i.amount,
      );
      for (const { code, amount } of changed) {
        if (amount === null) {
          await tx.subjectFee.deleteMany({ where: { schoolId, code } });
        } else {
          await tx.subjectFee.upsert({
            where: { schoolId_code: { schoolId, code } },
            create: { schoolId, code, amount },
            update: { amount },
          });
        }
      }
      return changed.map((i) => ({
        code: i.code,
        from: before.get(i.code) ?? null,
        to: i.amount,
      }));
    });

    if (changes.length) {
      await this.audit.record(actor.userId, 'FEE_SUBJECT_FEES_UPDATE', {
        schoolId,
        entityType: 'SubjectFee',
        metadata: { changes },
      });
    }
    return this.list(actor, schoolId);
  }
}
