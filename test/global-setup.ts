import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  WORKER_COUNT,
  databaseNameOf,
  maintenanceDatabaseUrl,
  workerDatabaseUrl,
} from './utils/worker-db';

// Runs once before the e2e suite: creates and migrates one database per Jest worker, so
// every worker starts from a migrated schema that no other worker truncates mid-test.
// globalSetup doesn't see `setupFiles`, so the URLs are resolved through the shared helper.

// execFile needs the real executable name; on Windows `npx` is a .cmd shim.
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export default async function globalSetup() {
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
      execFileSync(NPX, ['prisma', 'migrate', 'deploy'], {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: url },
      });
    }
  } finally {
    await admin.$disconnect();
  }
}
