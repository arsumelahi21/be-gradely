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
import { CreateFeeHeadDto } from './dto/create-fee-head.dto';
import { UpdateFeeHeadDto } from './dto/update-fee-head.dto';

type ListOpts = {
  page?: number;
  pageSize?: number;
  search?: string;
  activeOnly?: boolean;
};

@Injectable()
export class FeeHeadsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async create(dto: CreateFeeHeadDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(schoolId);
    try {
      return await this.prisma.feeHead.create({
        data: {
          schoolId,
          name: dto.name.trim(),
          defaultAmount: dto.defaultAmount,
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    } catch (e) {
      throw this.translateDuplicate(e, dto.name);
    }
  }

  async findAll(actor: Actor, schoolId?: string, opts?: ListOpts) {
    this.ensureAdmin(actor);
    const scopedSchoolId = this.resolveSchoolId(actor, schoolId);

    const where: Prisma.FeeHeadWhereInput = { schoolId: scopedSchoolId };
    if (opts?.activeOnly) where.isActive = true;
    if (opts?.search?.trim()) {
      where.name = { contains: opts.search.trim(), mode: 'insensitive' };
    }
    const orderBy: Prisma.FeeHeadOrderByWithRelationInput[] = [
      { sortOrder: 'asc' },
      { name: 'asc' },
    ];

    if (opts?.page != null) {
      const { skip, take, page, pageSize } = resolvePagination(opts);
      const [total, items] = await Promise.all([
        this.prisma.feeHead.count({ where }),
        this.prisma.feeHead.findMany({ where, orderBy, skip, take }),
      ]);
      return { items, total, page, pageSize };
    }
    return this.prisma.feeHead.findMany({ where, orderBy });
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateFeeHeadDto, actor: Actor) {
    await this.getOrThrow(id, actor);
    try {
      return await this.prisma.feeHead.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.defaultAmount !== undefined && {
            defaultAmount: dto.defaultAmount,
          }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        },
      });
    } catch (e) {
      throw this.translateDuplicate(e, dto.name);
    }
  }

  /**
   * Deleting a head used by past challans is blocked — the correct action is
   * deactivation, and the message says so.
   */
  async remove(id: string, actor: Actor) {
    const head = await this.getOrThrow(id, actor);
    const used = await this.prisma.challanItem.count({
      where: { feeHeadId: id },
    });
    if (used > 0) {
      throw new BadRequestException(
        `"${head.name}" is used on ${used} existing challan item(s) and cannot be deleted. Deactivate it instead — it will stop appearing on new challans.`,
      );
    }
    return this.prisma.feeHead.delete({ where: { id } });
  }

  private async getOrThrow(id: string, actor: Actor) {
    this.ensureAdmin(actor);
    const head = await this.prisma.feeHead.findUnique({ where: { id } });
    if (!head) throw new NotFoundException('Fee head not found');
    this.enforceScope(actor, head.schoolId);
    return head;
  }

  private translateDuplicate(e: unknown, name?: string) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return new ConflictException(
        `A fee head named "${name ?? ''}" already exists for this school`,
      );
    }
    return e as Error;
  }
}
