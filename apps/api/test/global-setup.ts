import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

/**
 * Applies pending migrations to the dedicated test database. Nothing is dropped:
 * every test creates its own users and organizations, so runs are isolated by tenant.
 */
export default function setup() {
  const startedAt = new Date();
  const envFile = resolve(__dirname, '../../../.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for integration tests (see .env.example)');
  if (!/test/i.test(url)) throw new Error('Refusing to run integration tests against a database whose URL does not contain "test"');
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '../../../packages/database'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = url;

  // MongoDB: same rule, the database name must say "test". Migrations run once per test run.
  const mongoUrl = process.env.TEST_MONGODB_URL;
  if (!mongoUrl) throw new Error('TEST_MONGODB_URL must be set for integration tests (see .env.example)');
  const dbName = new URL(mongoUrl.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1);
  if (!/test/i.test(dbName)) throw new Error('Refusing to run integration tests against a MongoDB database whose name does not contain "test"');
  if (!existsSync(resolve(__dirname, '../dist/db/migrate.js'))) throw new Error('Build the API first (pnpm build): the tests apply MongoDB migrations with dist/db/migrate.js');
  execSync('node dist/db/migrate.js', { cwd: resolve(__dirname, '..'), env: { ...process.env, MONGODB_URL: mongoUrl }, stdio: 'pipe' });
  process.env.MONGODB_URL = mongoUrl;
  process.env.JWT_SECRET ??= 'test-secret-that-is-long-enough-for-hs256-signing';

  // After every file: what this run wrote to PostgreSQL must be in MongoDB too (db/mirror-writes.ts).
  return async () => {
    const { checkMirrorSince } = await import('./mirror-check');
    const problems = await checkMirrorSince(startedAt);
    if (problems.length) {
      writeFileSync(resolve(__dirname, '../mirror-differences.txt'), problems.join('\n'));
      throw new Error(`${problems.length} differences between PostgreSQL and MongoDB (first: ${problems[0]}); all in apps/api/mirror-differences.txt`);
    }
  };
}
