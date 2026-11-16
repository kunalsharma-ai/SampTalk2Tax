import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Applies pending migrations to the dedicated test database. Nothing is dropped:
 * every test creates its own users and organizations, so runs are isolated by tenant.
 */
export default function setup() {
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
  process.env.JWT_SECRET ??= 'test-secret-that-is-long-enough-for-hs256-signing';
}
