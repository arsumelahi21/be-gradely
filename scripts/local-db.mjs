/**
 * Local development database (no system Postgres / Docker required).
 *
 * Runs a real, self-contained PostgreSQL server from `embedded-postgres` on
 * port 5433 with a data dir under `.pgdata/` (gitignored). Keep this process
 * running in a terminal while you develop; Ctrl+C stops it cleanly.
 *
 *   node scripts/local-db.mjs
 *
 * Connection string (put this in .env as DATABASE_URL):
 *   postgresql://postgres:postgres@localhost:5433/gradely?schema=public
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';

const databaseDir = path.resolve('.pgdata');
const port = Number(process.env.LOCAL_DB_PORT ?? 5433);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
});

const firstRun = !existsSync(databaseDir);
if (firstRun) {
  console.log('Initialising a fresh Postgres data directory...');
  await pg.initialise();
}

await pg.start();

// Create the app database on first run (ignore "already exists").
try {
  await pg.createDatabase('gradely');
  console.log('Created database "gradely".');
} catch {
  // database already exists — fine.
}

console.log(
  `\n✅ Local Postgres is running on port ${port} (db "gradely").\n` +
    `   DATABASE_URL=postgresql://postgres:postgres@localhost:${port}/gradely?schema=public\n` +
    `   Leave this process running. Press Ctrl+C to stop.\n`,
);

async function shutdown() {
  console.log('\nStopping local Postgres...');
  try {
    await pg.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the process alive so the server stays up.
setInterval(() => {}, 1 << 30);
