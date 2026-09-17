import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { resolvePagination } from '../../common/dto/pagination-query.dto';
import { CacheService } from '../../common/services/cache.service';
import { assertNoExaminationHistory } from '../../common/services/exam-history-guard';
import { pruneSectionRoster } from '../section-subjects/section-roster';

type UpdateSubjectInput = UpdateSubjectDto & Partial<CreateSubjectDto>;
type ListOpts = { page?: number; pageSize?: number; search?: string };

@Injectable()
export class SubjectsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  async create(dto: CreateSubjectDto, actor: Actor) {
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(schoolId);
    const created = await this.prisma.subject.create({
      data: {
        schoolId,
        name: dto.name,
        code: dto.code ?? null,
        description: dto.description ?? null,
        isCore: dto.isCore ?? true,
      },
    });
    await this.invalidateSchoolCache(schoolId, 'subjects');
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
      'subjects',
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
        const orderBy = { name: 'asc' as const };
        if (opts?.page != null) {
          const { skip, take, page, pageSize } = resolvePagination(opts);
          // Reads don't need a transaction; Promise.all runs count + page in
          // parallel (2 round-trips) instead of a serialized tx over the remote DB.
          const [total, items] = await Promise.all([
            this.prisma.subject.count({ where }),
            this.prisma.subject.findMany({ where, orderBy, skip, take }),
          ]);
          return { items, total, page, pageSize };
        }
        return this.prisma.subject.findMany({ where, orderBy });
      },
    );
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateSubjectInput, actor: Actor) {
    const subject = await this.getOrThrow(id, actor);
    const updated = await this.prisma.subject.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.code !== undefined && { code: dto.code }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.isCore !== undefined && { isCore: dto.isCore }),
      },
    });
    await this.invalidateSchoolCache(subject.schoolId, 'subjects');
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const subject = await this.getOrThrow(id, actor);
    // Allocations and specialties cascade and a quiz just loses the subject; only
    // examination history on its allocations refuses the delete (Restrict).
    await assertNoExaminationHistory(this.prisma, 'subject', id);
    const removed = await this.prisma.$transaction(async (tx) => {
      const allocations = await tx.sectionSubject.findMany({
        where: { subjectId: id },
        select: { sectionId: true },
        distinct: ['sectionId'],
      });
      const row = await tx.subject.delete({ where: { id } });
      // The cascade removes the allocations but not the roster rows they put teachers on.
      for (const { sectionId } of allocations) {
        await pruneSectionRoster(tx, sectionId);
      }
      return row;
    });
    // Section cards count this subject and its teachers, so their cached lists are stale too.
    await this.invalidateSchoolCache(
      subject.schoolId,
      'subjects',
      'sections',
      'classes',
    );
    return removed;
  }

  private async getOrThrow(id: string, actor: Actor) {
    const subject = await this.prisma.subject.findUnique({ where: { id } });
    if (!subject) {
      throw new NotFoundException('Subject not found');
    }
    this.enforceScope(actor, subject.schoolId);
    return subject;
  }
}
