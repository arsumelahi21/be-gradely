/**
 * One e2e database per Jest worker.
 *
 * `setup-env.ts` (per worker) and `global-setup.ts` (once, in the main process) must agree
 * on these names exactly: a worker whose database was never created fails with an opaque
 * Prisma error, so the naming rule lives here and nowhere else.
 */
const DB_IN_URL = /\/([^/?]+)(\?|$)/;

export const BASE_TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5433/gradely_test?schema=public';

export function databaseNameOf(url: string): string {
  const match = DB_IN_URL.exec(url);
  if (!match) throw new Error(`No database name in test database URL: ${url}`);
  return match[1];
}

// Resolved at import so a malformed TEST_DATABASE_URL fails before any suite starts.
const BASE_DB_NAME = databaseNameOf(BASE_TEST_DATABASE_URL);

const WORKERS_RAW = process.env.E2E_WORKERS ?? '2';
/** Must match `maxWorkers` in jest-e2e.json. */
export const WORKER_COUNT = Number(WORKERS_RAW);
if (!Number.isInteger(WORKER_COUNT) || WORKER_COUNT < 1) {
  // NaN would pass setup-env's `worker > WORKER_COUNT` guard and create no databases at
  // all, leaving the run to die on its first query instead of here.
  throw new Error(
    `E2E_WORKERS must be a positive integer, got "${WORKERS_RAW}"`,
  );
}

export function workerDatabaseUrl(worker: number | string): string {
  return BASE_TEST_DATABASE_URL.replace(
    DB_IN_URL,
    (_match, _db: string, tail: string) => `/${BASE_DB_NAME}_w${worker}${tail}`,
  );
}

/** CREATE DATABASE cannot run from inside the database being created. */
export function maintenanceDatabaseUrl(): string {
  return BASE_TEST_DATABASE_URL.replace(
    DB_IN_URL,
    (_match, _db: string, tail: string) => `/postgres${tail}`,
  );
}
