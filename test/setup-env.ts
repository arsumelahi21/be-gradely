// Runs via jest `setupFiles` before app code is imported, so services pick up these values at construction.
// Points the app at the SEPARATE test database — never dev/prod.

import { WORKER_COUNT, workerDatabaseUrl } from './utils/worker-db';

// One database per Jest worker: resetDb() TRUNCATEs every table between tests, so two
// workers sharing a database would wipe each other's fixtures mid-test.
const worker = Number(process.env.JEST_WORKER_ID ?? '1');
if (worker > WORKER_COUNT) {
  // Raising maxWorkers without E2E_WORKERS would otherwise surface as "database
  // gradely_test_w3 does not exist" from whichever query happened to run first.
  throw new Error(
    `Jest worker ${worker} has no database: global-setup.ts created ${WORKER_COUNT}. ` +
      `Set E2E_WORKERS=${worker} to match maxWorkers in jest-e2e.json.`,
  );
}
process.env.DATABASE_URL = workerDatabaseUrl(worker);

// When a Redis is configured, pin the suite to database index 1 so it never
// reads or flushes the dev cache on index 0. Set here, before anything else
// loads, because ConfigModule.forRoot() reads .env during app construction and
// dotenv only fills variables that are still undefined — so this value wins.
// Cleared between tests by resetDb(); without that, a cached response outlives
// the TRUNCATE and leaks into the next test.
//
// Left UNSET when there is none: CacheService then uses its in-memory backend.
// Pointing at a Redis that isn't there hangs the whole suite — CacheService
// reconnects forever — which is what CI does, having no redis service.
if (process.env.REDIS_URL) {
  process.env.REDIS_URL = process.env.REDIS_URL.replace(/\/\d+$/, '') + '/1';
}

process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
process.env.JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS || 'http://localhost:3000';

process.env.THROTTLE_LIMIT = process.env.THROTTLE_LIMIT || '1000000';

// The chatbot must answer deterministically here. Deleting ANTHROPIC_API_KEY is
// not enough: ConfigModule.forRoot() reads `.env` later, during app construction,
// and dotenv fills any variable that is currently UNDEFINED — so the delete just
// clears the slot for it to refill. This flag is set, not unset, so dotenv leaves
// it alone, and the provider factory honours it.
process.env.CHATBOT_DISABLE_LLM = 'true';

// Email is flagged OFF for beta in prod, but the e2e suite must exercise the
// notification email fan-out (per-preference suppression), so enable it here.
process.env.EMAIL_NOTIFICATIONS_ENABLED =
  process.env.EMAIL_NOTIFICATIONS_ENABLED || 'true';

// S3 placeholders so modules that construct an S3 client at boot don't throw.
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test';
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'test-bucket';
process.env.AWS_S3_PREFIX = process.env.AWS_S3_PREFIX || 'assignments/';
process.env.AWS_S3_PRESIGN_EXPIRES_IN_SECONDS =
  process.env.AWS_S3_PRESIGN_EXPIRES_IN_SECONDS || '900';
