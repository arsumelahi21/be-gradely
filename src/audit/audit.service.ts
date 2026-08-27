import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { FindAuditLogsQueryDto } from './dto/find-audit-logs-query.dto';

export interface AuditRecordOpts {
  schoolId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Fire-and-forget audit record — swallows errors so logging never breaks the action. Metadata must not carry sensitive values. */
  async record(
    actorUserId: string,
    action: string,
    opts?: AuditRecordOpts,
  ): Promise<void> {
    try {
      await (this.prisma as any).auditLog.create({
        data: {
          actorUserId,
          action,
          schoolId: opts?.schoolId ?? null,
          entityType: opts?.entityType ?? null,
          entityId: opts?.entityId ?? null,
          metadata: opts?.metadata ?? undefined,
        },
      });
    } catch (err) {
      this.logger.warn(`audit record failed (${action}): ${String(err)}`);
    }
  }

  /** Admin-only, tenant-scoped audit log list with optional filters. */
  async list(actor: Actor, query: FindAuditLogsQueryDto) {
    if (![Role.SUPER_ADMIN, Role.SCHOOL_ADMIN].includes(actor.role)) {
      throw new ForbiddenException('Not allowed');
    }
    const { page, pageSize, skip, take } = resolvePagination(query);

    const where: any = {};
    // SCHOOL_ADMIN is hard-pinned to their own school; SUPER_ADMIN sees all
    // (with an optional schoolId filter).
    if (actor.role === Role.SCHOOL_ADMIN) {
      where.schoolId = actor.schoolId;
    } else if (query.schoolId) {
      where.schoolId = query.schoolId;
    }
    if (query.actorUserId) where.actorUserId = query.actorUserId;
    if (query.action) where.action = query.action;
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const [total, items] = await this.prisma.$transaction([
      (this.prisma as any).auditLog.count({ where }),
      (this.prisma as any).auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);

    // Best-effort actor identity for display (actors may have been deleted).
    const actorIds: string[] = [
      ...new Set((items as any[]).map((i) => String(i.actorUserId))),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, email: true, fullName: true, role: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    return {
      page,
      pageSize,
      total,
      items: items.map((i: any) => ({
        ...i,
        actor: byId.get(i.actorUserId) ?? null,
      })),
    };
  }
}
