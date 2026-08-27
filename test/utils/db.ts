import { PrismaClient } from '@prisma/client';

// Standalone client for arranging/inspecting DB state in tests (separate from PrismaService).
// Reads DATABASE_URL from env, set to the test DB by test/setup-env.ts before this module loads.
export const prisma = new PrismaClient();

/**
 * Truncate every application table (keeping the migration history) so each
 * test starts from a clean slate. RESTART IDENTITY + CASCADE handles FKs.
 */
export async function resetDb(): Promise<void> {
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
