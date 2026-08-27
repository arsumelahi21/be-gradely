import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateAcademicYearDto } from './dto/create-academic-year.dto';
import { UpdateAcademicYearDto } from './dto/update-academic-year.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { resolvePagination } from '../../common/dto/pagination-query.dto';

type UpdateAcademicYearInput = UpdateAcademicYearDto &
  Partial<CreateAcademicYearDto>;
type ListOpts = { page?: number; pageSize?: number; search?: string };

@Injectable()
export class AcademicYearsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async create(dto: CreateAcademicYearDto, actor: Actor) {
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(schoolId);
    const { startDate, endDate } = this.validateDates(
      dto.startDate,
      dto.endDate,
    );
    return this.prisma.academicYear.create({
      data: {
        schoolId,
        name: dto.name,
        code: dto.code,
        startDate,
        endDate,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async findAll(
    actor: Actor,
    schoolId?: string,
    isActive?: boolean,
    opts?: ListOpts,
  ) {
    let scopedSchoolId: string | undefined;

    if (actor.role === Role.SUPER_ADMIN) {
      scopedSchoolId = schoolId ?? undefined;
    } else if (
      [Role.SCHOOL_ADMIN, Role.TEACHER, Role.STUDENT, Role.PARENT].includes(
        actor.role,
      )
    ) {
      if (!actor.schoolId) {
        throw new ForbiddenException(
          'No school context. Please ensure your user account has a schoolId set.',
        );
      }
      // For non-admin roles, if schoolId query param is provided, validate it matches their schoolId
      // Otherwise, use their actor.schoolId
      if (schoolId) {
        if (schoolId !== actor.schoolId) {
          throw new ForbiddenException(
            `Cannot access academic years from other schools. Your schoolId: ${actor.schoolId}, requested: ${schoolId}`,
          );
        }
        scopedSchoolId = actor.schoolId;
      } else {
        // No query param provided, use actor's schoolId
        scopedSchoolId = actor.schoolId;
      }
    } else {
      throw new ForbiddenException('Not allowed');
    }

    const where: any = {};
    if (scopedSchoolId) {
      where.schoolId = scopedSchoolId;
    }
    if (isActive !== undefined) {
      where.isActive = isActive;
    }
    if (opts?.search?.trim()) {
      const s = opts.search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { code: { contains: s, mode: 'insensitive' } },
      ];
    }

    const orderBy = { startDate: 'desc' as const };
    if (opts?.page != null) {
      const { skip, take, page, pageSize } = resolvePagination(opts);
      const [total, items] = await this.prisma.$transaction([
        this.prisma.academicYear.count({ where }),
        this.prisma.academicYear.findMany({ where, orderBy, skip, take }),
      ]);
      return { items, total, page, pageSize };
    }
    return this.prisma.academicYear.findMany({ where, orderBy });
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateAcademicYearInput, actor: Actor) {
    const record = await this.getOrThrow(id, actor);
    const startDate = dto.startDate
      ? new Date(dto.startDate)
      : record.startDate;
    const endDate = dto.endDate ? new Date(dto.endDate) : record.endDate;
    if (endDate <= startDate) {
      throw new BadRequestException('endDate must be after startDate');
    }
    return this.prisma.academicYear.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.code !== undefined && { code: dto.code }),
        startDate,
        endDate,
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async remove(id: string, actor: Actor) {
    await this.getOrThrow(id, actor);
    return this.prisma.academicYear.delete({ where: { id } });
  }

  private validateDates(start: string, end: string) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid dates');
    }
    if (endDate <= startDate) {
      throw new BadRequestException('endDate must be after startDate');
    }
    return { startDate, endDate };
  }

  private async getOrThrow(id: string, actor: Actor) {
    const record = await this.prisma.academicYear.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('Academic year not found');
    }
    this.enforceScope(actor, record.schoolId);
    return record;
  }
}
