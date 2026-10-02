import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../common/types/role.type';
import { Actor } from '../common/types/actor.type';
import { pickCurrentAcademicYear } from '../common/academic-year';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { StoredTargets, parseStoredTargets } from './targets';
import {
  InsightsWindow,
  RangeWindow,
  pickYear,
  resolveWindow,
  yearBefore,
  ymd,
} from './insights';

export interface ScopeBranch {
  id: string;
  name: string;
  code: string;
  city: string | null;
  currency: string;
  isActive: boolean;
  feeDueDayOfMonth: number;
}

export interface DirectorScope {
  directorId: string;
  group: { id: string; name: string };
  branches: ScopeBranch[];
  targets: StoredTargets;
}

export interface YearRef {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

export interface BranchContext {
  branch: ScopeBranch;
  /** The selected session (`ay`); null makes the branch `no_year`. */
  year: YearRef | null;
  /** Always the current session, for "this month" metrics even when ay=previous. */
  currentYear: YearRef | null;
  /** The session before `year`, for "this session vs last". */
  priorYear: YearRef | null;
  actor: Actor;
  range: RangeWindow;
  now: Date;
  /** True when the request names one branch rather than `all`. */
  single: boolean;
}

export interface BranchResult<T> {
  schoolId: string;
  name: string;
  code: string;
  currency: string;
  isActive: boolean;
  academicYear: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
  } | null;
  status: 'ok' | 'no_year' | 'error';
  data: T | null;
  error?: string;
}

export interface Insights<T, G> {
  generatedAt: string;
  window: InsightsWindow;
  branches: BranchResult<T>[];
  group: G;
  coverage: { ok: number; total: number };
}

const BRANCHES_AT_ONCE = 2;
const BRANCH_TIMEOUT_MS = 8_000;
// ponytail: in-process limits; move both to Redis once more than one API process serves directors.
const QUERY_SLOTS = 4;

class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private free: number) {}

  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

const yearRef = (y: YearRef | null) =>
  y && {
    id: y.id,
    name: y.name,
    startDate: ymd(y.startDate),
    endDate: ymd(y.endDate),
  };

@Injectable()
export class DirectorService {
  private readonly logger = new Logger(DirectorService.name);
  private readonly slots = new Semaphore(QUERY_SLOTS);
  private readonly inFlight = new Set<string>();

  constructor(private prisma: PrismaService) {}

  /**
   * Re-derived from the DB on every request and never cached, so a deactivation, detach,
   * SA password reset or API logout bites on the director's next request rather than when
   * the 15-minute access token expires.
   */
  async scope(userId: string): Promise<DirectorScope> {
    const director = await this.prisma.user.findFirst({
      where: {
        id: userId,
        role: Role.DIRECTOR,
        isActive: true,
        refreshTokenHash: { not: null },
      },
      select: {
        group: {
          select: {
            id: true,
            name: true,
            targets: true,
            schools: {
              orderBy: { name: 'asc' },
              select: {
                id: true,
                name: true,
                code: true,
                city: true,
                currency: true,
                isActive: true,
                feeDueDayOfMonth: true,
              },
            },
          },
        },
      },
    });
    // The DB CHECK guarantees a director has a group; a missing one means "not a director".
    if (!director?.group) throw new UnauthorizedException();
    const { schools, targets, ...group } = director.group;
    return {
      directorId: userId,
      group,
      branches: schools,
      targets: parseStoredTargets(targets),
    };
  }

  async branches(scope: DirectorScope) {
    const years = await this.activeYears(scope.branches.map((b) => b.id));
    const now = new Date();
    return {
      group: scope.group,
      branches: scope.branches.map((b) => ({
        schoolId: b.id,
        name: b.name,
        code: b.code,
        city: b.city,
        currency: b.currency,
        isActive: b.isActive,
        academicYear: yearRef(
          pickCurrentAcademicYear(years.get(b.id) ?? [], now),
        ),
      })),
    };
  }

  /** A foreign or unknown id is a 404 with the same body, so it never confirms another school exists. */
  selectBranches(scope: DirectorScope, branch?: string): ScopeBranch[] {
    if (!branch || branch === 'all') return scope.branches;
    const found = scope.branches.find((b) => b.id === branch);
    if (!found) throw new NotFoundException('Branch not found');
    return [found];
  }

  /**
   * Runs `load` for each selected branch and wraps the results in the 00 §3 envelope.
   * One failing or slow branch becomes an `error` row; it never fails the request.
   */
  async insights<T, G>(
    scope: DirectorScope,
    query: InsightsQueryDto,
    load: (ctx: BranchContext) => Promise<T>,
    rollUp: (rows: BranchResult<T>[]) => G,
    opts: { oneAtATime?: boolean } = { oneAtATime: true },
  ): Promise<Insights<T, G>> {
    const now = new Date();
    const range = resolveWindow(query, now);
    const selected = this.selectBranches(scope, query.branch);

    // One fan-out per director at a time, so a few open tabs can't drain the DB pool.
    if (opts.oneAtATime) {
      if (this.inFlight.has(scope.directorId))
        throw new HttpException(
          'Your previous request is still loading',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      this.inFlight.add(scope.directorId);
    }
    try {
      const years = await this.activeYears(selected.map((b) => b.id));
      const single = selected.length === 1 && query.branch === selected[0].id;
      const rows = await this.fanOut(selected, async (branch) => {
        const own = years.get(branch.id) ?? [];
        const year = pickYear(own, query.ay ?? 'current', now);
        const ctx: BranchContext = {
          branch,
          year,
          priorYear: yearBefore(own, year),
          currentYear: pickCurrentAcademicYear(own, now),
          actor: this.pinnedActor(scope.directorId, branch),
          range,
          now,
          single,
        };
        const base = {
          schoolId: branch.id,
          name: branch.name,
          code: branch.code,
          currency: branch.currency,
          isActive: branch.isActive,
          academicYear: yearRef(ctx.year),
        };
        const outcome = await this.withTimeout(() => load(ctx));
        if ('error' in outcome) {
          return {
            ...base,
            status: 'error' as const,
            data: null,
            error: outcome.error,
          };
        }
        return {
          ...base,
          status: ctx.year ? 'ok' : 'no_year',
          data: outcome.value,
        } as BranchResult<T>;
      });

      const counted = rows.filter((r) => r.isActive || query.includeSuspended);
      return {
        generatedAt: now.toISOString(),
        window: range.window,
        branches: rows,
        group: rollUp(counted.filter((r) => r.status !== 'error')),
        coverage: {
          ok: counted.filter((r) => r.status === 'ok').length,
          total: counted.length,
        },
      };
    } finally {
      if (opts.oneAtATime) this.inFlight.delete(scope.directorId);
    }
  }

  /**
   * The only way a director reaches an existing per-school service: as that branch's principal,
   * with the branch taken from the DB scope. Read whitelist only (00 §6, director-whitelist.spec);
   * never pass it to a write path and never make it a SUPER_ADMIN.
   */
  private pinnedActor(directorId: string, branch: ScopeBranch): Actor {
    return { userId: directorId, role: Role.SCHOOL_ADMIN, schoolId: branch.id };
  }

  private async activeYears(schoolIds: string[]) {
    const rows = await this.prisma.academicYear.findMany({
      where: { schoolId: { in: schoolIds }, isActive: true },
      select: {
        id: true,
        name: true,
        schoolId: true,
        startDate: true,
        endDate: true,
      },
    });
    const bySchool = new Map<string, YearRef[]>();
    for (const { schoolId, ...year } of rows) {
      bySchool.set(schoolId, [...(bySchool.get(schoolId) ?? []), year]);
    }
    return bySchool;
  }

  private async fanOut<I, O>(
    items: I[],
    run: (item: I) => Promise<O>,
  ): Promise<O[]> {
    const out = new Array<O>(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BRANCHES_AT_ONCE, items.length) }, worker),
    );
    return out;
  }

  /**
   * A timeout can't cancel a Prisma query, so the slot is held until the work really
   * settles; only the response stops waiting for it.
   */
  private async withTimeout<T>(
    work: () => Promise<T>,
  ): Promise<{ value: T } | { error: 'timeout' | 'unavailable' }> {
    await this.slots.acquire();
    const settled = work().then(
      (value) => ({ value }),
      (err: unknown) => {
        this.logger.error(`Director branch load failed: ${String(err)}`);
        return { error: 'unavailable' as const };
      },
    );
    void settled.finally(() => this.slots.release());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ error: 'timeout' }>((resolve) => {
      timer = setTimeout(
        () => resolve({ error: 'timeout' }),
        BRANCH_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([settled, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
