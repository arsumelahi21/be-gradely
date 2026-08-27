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
import { CreateDiscountDto } from './dto/create-discount.dto';
import { UpdateDiscountDto } from './dto/update-discount.dto';
import { DiscountType } from './fees.types';

type ListOpts = {
  page?: number;
  pageSize?: number;
  search?: string;
  activeOnly?: boolean;
};

@Injectable()
export class DiscountsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async create(dto: CreateDiscountDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(schoolId);
    this.assertValueInRange(dto.type, dto.value);

    try {
      return await this.prisma.discount.create({
        data: {
          schoolId,
          name: dto.name.trim(),
          type: dto.type,
          value: dto.value,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (e) {
      throw this.translateDuplicate(e, dto.name);
    }
  }

  async findAll(actor: Actor, schoolId?: string, opts?: ListOpts) {
    this.ensureAdmin(actor);
    const scopedSchoolId = this.resolveSchoolId(actor, schoolId);

    const where: Prisma.DiscountWhereInput = { schoolId: scopedSchoolId };
    if (opts?.activeOnly) where.isActive = true;
    if (opts?.search?.trim()) {
      where.name = { contains: opts.search.trim(), mode: 'insensitive' };
    }
    const orderBy: Prisma.DiscountOrderByWithRelationInput = { name: 'asc' };

    if (opts?.page != null) {
      const { skip, take, page, pageSize } = resolvePagination(opts);
      const [total, items] = await Promise.all([
        this.prisma.discount.count({ where }),
        this.prisma.discount.findMany({ where, orderBy, skip, take }),
      ]);
      return { items, total, page, pageSize };
    }
    return this.prisma.discount.findMany({ where, orderBy });
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateDiscountDto, actor: Actor) {
    const existing = await this.getOrThrow(id, actor);
    this.assertValueInRange(
      dto.type ?? (existing.type as DiscountType),
      dto.value ?? existing.value,
    );
    try {
      return await this.prisma.discount.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.value !== undefined && { value: dto.value }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      });
    } catch (e) {
      throw this.translateDuplicate(e, dto.name);
    }
  }

  /**
   * Deleting a discount does NOT delete students — the FK is SetNull, so
   * assigned students simply lose the discount from their next challan on.
   */
  async remove(id: string, actor: Actor) {
    await this.getOrThrow(id, actor);
    return this.prisma.discount.delete({ where: { id } });
  }

  /** How many students currently hold this discount (shown before deleting). */
  async assignedCount(id: string, actor: Actor) {
    await this.getOrThrow(id, actor);
    const count = await this.prisma.studentProfile.count({
      where: { discountId: id },
    });
    return { count };
  }

  private assertValueInRange(type: DiscountType, value: number) {
    if (type === DiscountType.PERCENT && value > 100) {
      throw new BadRequestException('A percentage discount cannot exceed 100');
    }
  }

  private async getOrThrow(id: string, actor: Actor) {
    this.ensureAdmin(actor);
    const discount = await this.prisma.discount.findUnique({ where: { id } });
    if (!discount) throw new NotFoundException('Discount not found');
    this.enforceScope(actor, discount.schoolId);
    return discount;
  }

  private translateDuplicate(e: unknown, name?: string) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return new ConflictException(
        `A discount named "${name ?? ''}" already exists for this school`,
      );
    }
    return e as Error;
  }
}
