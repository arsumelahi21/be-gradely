import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateClassGradeDto } from './dto/create-class-grade.dto';
import { UpdateClassGradeDto } from './dto/update-class-grade.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { resolvePagination } from '../../common/dto/pagination-query.dto';
import { CacheService } from '../../common/services/cache.service';

type UpdateClassGradeInput = UpdateClassGradeDto & Partial<CreateClassGradeDto>;
type ListOpts = { page?: number; pageSize?: number; search?: string };

@Injectable()
export class ClassGradesService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  async create(dto: CreateClassGradeDto, actor: Actor) {
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(schoolId);
    const created = await this.prisma.classGrade.create({
      data: {
        schoolId,
        name: dto.name,
        code: dto.code ?? null,
        description: dto.description ?? null,
      },
      include: {
        sections: true,
      },
    });
    await this.invalidateSchoolCache(schoolId, 'classes');
    return created;
  }

  async findAll(actor: Actor, schoolId?: string, opts?: ListOpts) {
    this.ensureAdmin(actor);
    const scopedSchoolId =
      actor.role === Role.SUPER_ADMIN
        ? (schoolId ?? undefined)
        : actor.schoolId!;
    const variant = {
      page: opts?.page ?? null,
      pageSize: opts?.pageSize ?? null,
      search: opts?.search?.trim() || null,
    };
    return this.cachedSchoolList(
      scopedSchoolId,
      'classes',
      variant,
      async () => {
        const where: any = {};
        if (scopedSchoolId) where.schoolId = scopedSchoolId;
        if (opts?.search?.trim()) {
          const s = opts.search.trim();
          where.OR = [
            { name: { contains: s, mode: 'insensitive' } },
            { code: { contains: s, mode: 'insensitive' } },
          ];
        }
        const orderBy = { createdAt: 'desc' as const };
        const include = { sections: { orderBy: { name: 'asc' as const } } };
        if (opts?.page != null) {
          const { skip, take, page, pageSize } = resolvePagination(opts);
          // Reads don't need a transaction; Promise.all runs count + page in
          // parallel. Default relation-load strategy beats 'join' here (one-to-many).
          const [total, items] = await Promise.all([
            this.prisma.classGrade.count({ where }),
            this.prisma.classGrade.findMany({
              where,
              orderBy,
              include,
              skip,
              take,
            }),
          ]);
          return { items, total, page, pageSize };
        }
        return this.prisma.classGrade.findMany({ where, orderBy, include });
      },
    );
  }

  async findOne(id: string, actor: Actor) {
    const grade = await this.prisma.classGrade.findUnique({
      where: { id },
      include: {
        sections: {
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!grade) {
      throw new NotFoundException('Class grade not found');
    }
    this.enforceScope(actor, grade.schoolId);
    return grade;
  }

  async update(id: string, dto: UpdateClassGradeInput, actor: Actor) {
    const grade = await this.getOrThrow(id, actor);
    const updated = await this.prisma.classGrade.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.code !== undefined && { code: dto.code }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: {
        sections: {
          orderBy: { name: 'asc' },
        },
      },
    });
    await this.invalidateSchoolCache(grade.schoolId, 'classes');
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const grade = await this.getOrThrow(id, actor);
    const removed = await this.prisma.classGrade.delete({ where: { id } });
    // A grade's sections cascade-delete, so the sections list is stale too.
    await this.invalidateSchoolCache(grade.schoolId, 'classes', 'sections');
    return removed;
  }

  private async getOrThrow(id: string, actor: Actor) {
    const grade = await this.prisma.classGrade.findUnique({ where: { id } });
    if (!grade) {
      throw new NotFoundException('Class grade not found');
    }
    this.enforceScope(actor, grade.schoolId);
    return grade;
  }
}
