import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';

// Standalone client for arranging/inspecting DB state in tests (separate from PrismaService).
// Reads DATABASE_URL from env, set to the test DB by test/setup-env.ts before this module loads.
export const prisma = new PrismaClient();

/**
 * Cache client for the TEST Redis database (index 1, pinned in setup-env.ts).
 * Lazy: a suite run with no Redis reachable must still work — CacheService is
 * fail-open, so an unflushed cache is the only consequence.
 */
let cache: Redis | null = null;
function cacheClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!cache) {
    cache = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      commandTimeout: 1000,
      lazyConnect: true,
    });
    // Never let a dead Redis fail a test run.
    cache.on('error', () => undefined);
  }
  return cache;
}

/** Drop the cached responses too — a TRUNCATE alone leaves them serving deleted rows. */
async function resetCache(): Promise<void> {
  const client = cacheClient();
  if (!client) return;
  try {
    await client.flushdb();
  } catch {
    // Fail-open, exactly as CacheService does.
  }
}

/** Close the cache connection so Jest can exit cleanly. */
export async function disconnectCache(): Promise<void> {
  if (!cache) return;
  try {
    cache.disconnect();
  } catch {
    // already gone
  }
  cache = null;
}

/**
 * Truncate every application table (keeping the migration history) so each
 * test starts from a clean slate. RESTART IDENTITY + CASCADE handles FKs.
 */
export async function resetDb(): Promise<void> {
  await resetCache();
  const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  const sql = `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`;

  // Async listener writes can outlive the request and briefly hold row locks, so a between-test
  // TRUNCATE can hit a transient deadlock (Postgres 40P01) — retry resolves it.
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(sql);
      return;
    } catch (e) {
      const msg = String((e as Error)?.message ?? '');
      const transient = msg.includes('deadlock') || msg.includes('40P01');
      if (!transient || attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
}
