// Runs via jest `setupFiles` before app code is imported, so services pick up these values at construction.
// Points the app at the SEPARATE test database — never dev/prod.

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5433/gradely_test?schema=public';

process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
process.env.JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS || 'http://localhost:3000';

// The global 100/min/IP cap would 429 the bigger suites (fees fires far more
// than that in a minute). Route-level @Throttle limits (login 5/min) are
// untouched, so throttle.e2e-spec.ts still exercises the real guard.
process.env.THROTTLE_LIMIT = process.env.THROTTLE_LIMIT || '1000000';

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
