import { execSync } from 'node:child_process';
import {
  WORKER_COUNT,
  databaseNameOf,
  maintenanceDatabaseUrl,
  workerDatabaseUrl,
} from './utils/worker-db';

// One migrated database per Jest worker, so no worker truncates another's schema mid-test.
// globalSetup doesn't see `setupFiles`, so the URLs are resolved through the shared helper.

export default async function globalSetup() {
  // Importing @prisma/client loads .env into this process and the workers inherit it, so
  // setup-env's `X || default` would pick up dev values. Import late, restore env after.
  const envBefore = { ...process.env };
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: maintenanceDatabaseUrl() });

  try {
    for (let worker = 1; worker <= WORKER_COUNT; worker++) {
      const url = workerDatabaseUrl(worker);
      // Identifier comes from TEST_DATABASE_URL, never from a test or request.
      try {
        await admin.$executeRawUnsafe(
          `CREATE DATABASE "${databaseNameOf(url)}"`,
        );
      } catch (error) {
        // 42P04 is "already exists" — the normal case on every run after the first.
        const message = String(error);
        if (!message.includes('42P04') && !message.includes('already exists')) {
          throw error;
        }
      }
      // execSync runs through a shell: execFile on Windows' `npx.cmd` shim throws EINVAL.
      execSync('npx prisma migrate deploy', {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: url },
      });
    }
  } finally {
    await admin.$disconnect();
    for (const key of Object.keys(process.env)) {
      if (!(key in envBefore)) delete process.env[key];
    }
    Object.assign(process.env, envBefore);
  }
}
