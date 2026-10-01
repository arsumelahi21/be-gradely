import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../common/types/role.type';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
} from './director.service';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { daysSince } from './insights';

// 00 §7: a principal who has not signed in for 14 days is worth a nudge.
const PRINCIPAL_INACTIVE_DAYS = 14;

export interface PrincipalRow {
  id: string;
  fullName: string | null;
  email: string;
  isActive: boolean;
  /** A lower bound: login is the only sign-in the audit trail records. */
  lastLoginAt: string | null;
  daysSinceLogin: number | null;
}

export interface PrincipalsData {
  principals: PrincipalRow[];
}

export interface PrincipalsGroup {
  principals: number;
  branchesWithoutPrincipal: number;
  quiet: number;
}

/** Read-only: the Super Admin creates and manages principals; the director only sees them. */
@Injectable()
export class DirectorPrincipalsService {
  constructor(
    private director: DirectorService,
    private prisma: PrismaService,
  ) {}

  list(scope: DirectorScope, query: InsightsQueryDto) {
    return this.director.insights<PrincipalsData, PrincipalsGroup>(
      scope,
      query,
      (ctx) => this.branchPrincipals(ctx),
      (rows) => this.rollUp(rows),
    );
  }

  private async branchPrincipals({
    branch,
    now,
  }: BranchContext): Promise<PrincipalsData> {
    const users = await this.prisma.user.findMany({
      where: { schoolId: branch.id, role: Role.SCHOOL_ADMIN },
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      // No phone and no profile: name, email and status are all a director needs (00 §8).
      select: { id: true, fullName: true, email: true, isActive: true },
    });
    // Only who and when: audit metadata can carry other people's names (M19).
    const logins = users.length
      ? await this.prisma.auditLog.groupBy({
          by: ['actorUserId'],
          where: {
            actorUserId: { in: users.map((u) => u.id) },
            action: 'LOGIN',
          },
          _max: { createdAt: true },
        })
      : [];
    const lastLogin = new Map(
      logins.map((l) => [l.actorUserId, l._max.createdAt]),
    );
    return {
      principals: users.map((u) => {
        const at = lastLogin.get(u.id) ?? null;
        return {
          ...u,
          lastLoginAt: at?.toISOString() ?? null,
          daysSinceLogin: at ? daysSince(at, now) : null,
        };
      }),
    };
  }

  private rollUp(rows: BranchResult<PrincipalsData>[]): PrincipalsGroup {
    const group = { principals: 0, branchesWithoutPrincipal: 0, quiet: 0 };
    for (const { data } of rows) {
      if (!data) continue;
      const active = data.principals.filter((p) => p.isActive);
      group.principals += active.length;
      if (active.length === 0) group.branchesWithoutPrincipal++;
      group.quiet += active.filter(
        (p) =>
          p.daysSinceLogin === null ||
          p.daysSinceLogin > PRINCIPAL_INACTIVE_DAYS,
      ).length;
    }
    return group;
  }
}
