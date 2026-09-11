import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateClassGradeDto } from './dto/create-class-grade.dto';
import { UpdateClassGradeDto } from './dto/update-class-grade.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { resolvePagination } from '../../common/dto/pagination-query.dto';
import { CacheService } from '../../common/services/cache.service';
import {
  describeBlockers,
  isRestrictedDelete,
  uniqueConflict,
} from '../../common/utils/prisma-errors';
import { CLASS_LEVEL_ORDER_BY } from '../../common/types/class-level.type';

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
    const created = await this.prisma.classGrade
      .create({
        data: {
          schoolId,
          name: dto.name,
          code: dto.code ?? null,
          description: dto.description ?? null,
          defaultMonthlyFee: dto.defaultMonthlyFee ?? null,
          level: dto.level ?? null,
        },
        include: {
          sections: true,
        },
      })
      // @@unique([schoolId, name])
      .catch(uniqueConflict(`A class named "${dto.name}" already exists.`));
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
        // By ladder position, not creation date — a class added later still
        // appears between its neighbours.
        const orderBy = CLASS_LEVEL_ORDER_BY;
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
    const updated = await this.prisma.classGrade
      .update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.code !== undefined && { code: dto.code }),
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
          // `!== undefined`, never truthiness: 0 is a real (free) default and
          // null explicitly clears it.
          ...(dto.defaultMonthlyFee !== undefined && {
            defaultMonthlyFee: dto.defaultMonthlyFee,
          }),
          // Same reasoning: level -3 is PG, so `!== undefined` not truthiness.
          ...(dto.level !== undefined && { level: dto.level }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
        include: {
          sections: {
            orderBy: { name: 'asc' },
          },
        },
      })
      .catch(
        uniqueConflict(
          `A class named "${dto.name ?? grade.name}" already exists.`,
        ),
      );
    await this.invalidateSchoolCache(grade.schoolId, 'classes');
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const grade = await this.getOrThrow(id, actor);
    let removed;
    try {
      removed = await this.prisma.classGrade.delete({ where: { id } });
    } catch (e) {
      // Section.classGrade has NO cascade despite what this comment used to
      // claim — a class with sections cannot be deleted, and said so with a 500.
      if (!isRestrictedDelete(e)) throw e;
      const sections = await this.prisma.section.count({
        where: { classGradeId: id },
      });
      throw new ConflictException(
        sections
          ? `This class still has ${describeBlockers([[sections, 'section', 'sections']])}. Delete them first.`
          : 'This class is still in use and cannot be deleted.',
      );
    }
    // Sections are gone with it, so the sections list is stale too.
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
