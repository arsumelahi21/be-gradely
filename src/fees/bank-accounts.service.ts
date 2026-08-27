import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { Actor } from '../common/types/actor.type';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';

type ListOpts = {
  page?: number;
  pageSize?: number;
  search?: string;
  activeOnly?: boolean;
};

@Injectable()
export class BankAccountsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async create(dto: CreateBankAccountDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(schoolId);

    try {
      // Create + demote-others in one transaction so "exactly one default" holds.
      return await this.prisma.$transaction(async (tx) => {
        const makeDefault = dto.isDefault ?? false;
        if (makeDefault) {
          await tx.bankAccount.updateMany({
            where: { schoolId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.bankAccount.create({
          data: {
            schoolId,
            bankName: dto.bankName.trim(),
            accountTitle: dto.accountTitle.trim(),
            accountNumber: dto.accountNumber.trim(),
            iban: dto.iban?.trim() || null,
            branch: dto.branch?.trim() || null,
            isActive: dto.isActive ?? true,
            isDefault: makeDefault,
          },
        });
      });
    } catch (e) {
      throw this.translateDuplicate(e);
    }
  }

  async findAll(actor: Actor, schoolId?: string, opts?: ListOpts) {
    this.ensureAdmin(actor);
    const scopedSchoolId = this.resolveSchoolId(actor, schoolId);

    const where: Prisma.BankAccountWhereInput = { schoolId: scopedSchoolId };
    if (opts?.activeOnly) where.isActive = true;
    if (opts?.search?.trim()) {
      const s = opts.search.trim();
      where.OR = [
        { bankName: { contains: s, mode: 'insensitive' } },
        { accountTitle: { contains: s, mode: 'insensitive' } },
        { accountNumber: { contains: s, mode: 'insensitive' } },
      ];
    }
    const orderBy: Prisma.BankAccountOrderByWithRelationInput[] = [
      { isDefault: 'desc' },
      { bankName: 'asc' },
    ];

    if (opts?.page != null) {
      const { skip, take, page, pageSize } = resolvePagination(opts);
      const [total, items] = await Promise.all([
        this.prisma.bankAccount.count({ where }),
        this.prisma.bankAccount.findMany({ where, orderBy, skip, take }),
      ]);
      return { items, total, page, pageSize };
    }
    return this.prisma.bankAccount.findMany({ where, orderBy });
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateBankAccountDto, actor: Actor) {
    const existing = await this.getOrThrow(id, actor);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault === true) {
          await tx.bankAccount.updateMany({
            where: {
              schoolId: existing.schoolId,
              isDefault: true,
              NOT: { id },
            },
            data: { isDefault: false },
          });
        }
        return tx.bankAccount.update({
          where: { id },
          data: {
            ...(dto.bankName !== undefined && {
              bankName: dto.bankName.trim(),
            }),
            ...(dto.accountTitle !== undefined && {
              accountTitle: dto.accountTitle.trim(),
            }),
            ...(dto.accountNumber !== undefined && {
              accountNumber: dto.accountNumber.trim(),
            }),
            ...(dto.iban !== undefined && { iban: dto.iban?.trim() || null }),
            ...(dto.branch !== undefined && {
              branch: dto.branch?.trim() || null,
            }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
            ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
          },
        });
      });
    } catch (e) {
      throw this.translateDuplicate(e);
    }
  }

  /** Blocked while challans reference the account — deactivate instead. */
  async remove(id: string, actor: Actor) {
    const account = await this.getOrThrow(id, actor);
    const used = await this.prisma.challan.count({
      where: { bankAccountId: id },
    });
    if (used > 0) {
      throw new BadRequestException(
        `${account.bankName} — ${account.accountNumber} is printed on ${used} existing challan(s) and cannot be deleted. Deactivate it instead.`,
      );
    }
    return this.prisma.bankAccount.delete({ where: { id } });
  }

  private async getOrThrow(id: string, actor: Actor) {
    this.ensureAdmin(actor);
    const account = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Bank account not found');
    this.enforceScope(actor, account.schoolId);
    return account;
  }

  private translateDuplicate(e: unknown) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return new ConflictException(
        'An account with this number already exists for this school',
      );
    }
    return e as Error;
  }
}
