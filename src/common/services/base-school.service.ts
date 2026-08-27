import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../types/actor.type';
import { Role } from '../types/role.type';
import { CacheService } from './cache.service';
import {
  SCHOOL_CACHE_TTL_SECONDS,
  SchoolCacheEntity,
  schoolCacheKey,
  schoolCachePrefix,
} from '../cache/school-cache';
import { invalidateSchoolStats } from '../cache/stats-cache';

export abstract class BaseSchoolScopedService {
  // `cache` is optional so subclasses that don't cache keep calling `super(prisma)`.
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly cache?: CacheService,
  ) {}

  /**
   * Cache-aside read of a per-school list. Skips the cache when there's no
   * concrete `schoolId` (e.g. SUPER_ADMIN) or no CacheService, so cross-tenant data is never served stale.
   */
  protected cachedSchoolList<T>(
    schoolId: string | undefined,
    entity: SchoolCacheEntity,
    variant: unknown,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (!schoolId || !this.cache) return compute();
    return this.cache.wrap(
      schoolCacheKey(schoolId, entity, variant),
      SCHOOL_CACHE_TTL_SECONDS,
      compute,
    );
  }

  /** Invalidate every cached variant of a school's list(s) — call after a write.
   *  ONE keyspace scan for all entities (not one scan per entity). */
  protected async invalidateSchoolCache(
    schoolId: string | null | undefined,
    ...entities: SchoolCacheEntity[]
  ): Promise<void> {
    if (!schoolId || !this.cache) return;
    await this.cache.delByPrefixes(
      ...entities.map((e) => schoolCachePrefix(schoolId, e)),
    );
  }

  /**
   * Thin wrapper over the shared `invalidateSchoolStats` util for services that
   * extend this base (others import the util directly). Call AFTER commit.
   */
  protected invalidateSchoolStats(
    schoolId: string | null | undefined,
  ): Promise<void> {
    return invalidateSchoolStats(this.cache, schoolId);
  }

  protected ensureAdmin(actor: Actor) {
    if (![Role.SUPER_ADMIN, Role.SCHOOL_ADMIN].includes(actor.role)) {
      throw new ForbiddenException('Not allowed');
    }
    if (actor.role === Role.SCHOOL_ADMIN && !actor.schoolId) {
      throw new ForbiddenException('No school context');
    }
  }

  protected resolveSchoolId(actor: Actor, schoolId?: string) {
    if (actor.role === Role.SUPER_ADMIN) {
      if (!schoolId) {
        throw new BadRequestException('schoolId is required');
      }
      return schoolId;
    }
    if (actor.role === Role.SCHOOL_ADMIN) {
      if (!actor.schoolId) {
        throw new ForbiddenException('No school context');
      }
      return actor.schoolId;
    }
    throw new ForbiddenException('Not allowed');
  }

  protected enforceScope(actor: Actor, schoolId: string) {
    if (actor.role === Role.SUPER_ADMIN) {
      return;
    }
    if (!actor.schoolId || actor.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
  }

  protected async ensureSchoolExists(schoolId: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });
    if (!school) {
      throw new BadRequestException('Invalid schoolId');
    }
  }
}
