import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';

/**
 * OPTIONAL connection-pool keep-alive for LOCAL DEV against a REMOTE Postgres —
 * idle connections drop, costing a cold handshake. Off by default (`DB_POOL_KEEPALIVE=on`); pointless in prod and an oversized warm once starved it, so it's capped below the pool limit.
 *
 * ponytail: a workaround for having no pooler over a remote link. The durable fix
 * is PgBouncer next to the DB — or just co-locate, as production already does.
 */
const KEEPALIVE_ENABLED = process.env.DB_POOL_KEEPALIVE === 'on';

/**
 * Warm at most `connection_limit - 1` connections (leaves one free). Falls back
 * to a small count if the limit isn't set, so a forgotten param can't flood it.
 */
function warmCount(): number {
  const m = (process.env.DATABASE_URL ?? '').match(
    /[?&]connection_limit=(\d+)/,
  );
  const pool = m ? Number(m[1]) : 3;
  return Math.max(1, Math.min(pool, 15) - 1);
}

@Injectable()
export class PrismaWarmerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PrismaWarmerService.name);
  private readonly warm = warmCount();

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    if (KEEPALIVE_ENABLED) {
      this.logger.log(
        `DB pool keep-alive ON (warming ${this.warm} connections every 12s)`,
      );
      void this.keepPoolWarm();
    }
  }

  @Interval(12000)
  async keepPoolWarm(): Promise<void> {
    // Off unless explicitly enabled; never runs under test.
    if (!KEEPALIVE_ENABLED || process.env.NODE_ENV === 'test') return;
    try {
      // pg_sleep(0.05) holds each connection ~50ms so they're acquired together,
      // pinning `warm` distinct physical connections open — never the whole pool.
      await Promise.all(
        Array.from(
          { length: this.warm },
          () => this.prisma.$queryRaw`SELECT pg_sleep(0.05)`,
        ),
      );
    } catch (e) {
      // Fail-open: a transient DB blip must not crash the keep-alive.
      this.logger.warn(`pool keep-alive failed: ${(e as Error).message}`);
    }
  }
}
