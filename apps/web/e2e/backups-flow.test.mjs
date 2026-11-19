/**
 * Browser end-to-end test for backups and disaster recovery (SEC-021/022): the backup command
 * takes an encrypted backup of the real test database, checks it and runs a restore drill, and
 * a platform administrator sees each run under Platform admin → Backups.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const SHOTS = process.env.SHOTS_DIR;
const DIR = mkdtempSync(join(tmpdir(), 't2t-e2e-backups-'));
const backup = (...args) => execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/db/backup.js', ...args], { cwd: API_DIR, encoding: 'utf8', env: { ...process.env, BACKUP_ENCRYPTION_KEY: 'browser-test-backup-key-only' } });
let browser;
const consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  rmSync(DIR, { recursive: true, force: true });
});

test('a backup, a check and a restore drill show under Platform admin → Backups', async () => {
  const email = `e2e-backups-admin-${randomUUID().slice(0, 8)}@example.test`;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Backups Admin');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', email], { cwd: API_DIR, encoding: 'utf8' });

  assert.match(backup('create', '--out', DIR, '--keep', '3'), /^Backed up to .*\.t2tbak: [\d,]+ documents in \d+ collections, .* encrypted/);
  const [file] = readdirSync(DIR).filter((f) => f.endsWith('.t2tbak'));
  assert.ok(file);
  assert.match(backup('verify', '--in', join(DIR, file)), /^The backup is whole: /);
  assert.match(backup('drill', '--in', join(DIR, file)), /^Restore drill passed in [\d.]+ s: /);

  await page.goto(`${WEB}/admin/backups`);
  const runs = page.getByRole('table', { name: 'Backup runs' });
  await runs.waitFor();
  const rows = await runs.locator('tbody tr').allInnerTexts();
  const mine = rows.filter((r) => r.includes(file));
  assert.equal(mine.length, 3);
  assert.match(mine[0], /Restore drill\s+Passed/);
  assert.match(mine[1], /Check\s+Passed/);
  assert.match(mine[2], /Backup\s+Passed/);
  // The newest drill is the one just run.
  await page.getByText('Last restore drill').waitFor();
  await page.getByRole('combobox', { name: 'Kind' }).selectOption('RESTORE_DRILL');
  await page.waitForFunction(() => [...document.querySelectorAll('table[aria-label="Backup runs"] tbody tr')].every((r) => r.textContent.includes('Restore drill')));
  await page.getByRole('combobox', { name: 'Kind' }).selectOption('');
  await runs.locator('tbody tr', { hasText: 'Check' }).first().waitFor();
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/backups.png`, fullPage: true });
  }
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
