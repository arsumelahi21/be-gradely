import { execSync } from 'node:child_process';

// Runs once before the e2e suite: applies migrations so local/CI start from a migrated DB.
// globalSetup doesn't see `setupFiles`, so the test DB URL is resolved here independently.
export default async function globalSetup() {
  const url =
    process.env.TEST_DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/gradely_test?schema=public';

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
