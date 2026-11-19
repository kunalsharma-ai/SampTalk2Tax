/**
 * Browser end-to-end test for security event monitoring (SEC-023): a platform role is given, a
 * super admin checks the audit trail now under Platform admin → Security monitoring, sees the
 * alert and the events, and acknowledges the alert with a note. Real Next.js app → real API →
 * real MongoDB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const SHOTS = process.env.SHOTS_DIR;
let browser;
const consoleErrors = [];
const grant = (email, role) => execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', email, ...(role ? ['--role', role] : [])], { cwd: API_DIR, encoding: 'utf8' });

async function register(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  return page;
}

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

test('a super admin reviews a security alert and acknowledges it', async () => {
  const tag = randomUUID().slice(0, 8);
  const adminEmail = `e2e-security-admin-${tag}@example.test`;
  const admin = await register('Security Watch Admin', adminEmail);
  grant(adminEmail);
  const helperEmail = `e2e-security-helper-${tag}@example.test`;
  const helper = await register(`Helper ${tag}`, helperEmail);
  await helper.context().close();
  grant(helperEmail, 'SUPPORT');

  await admin.goto(`${WEB}/admin`);
  await admin.getByRole('link', { name: 'Security monitoring', exact: true }).click();
  await admin.waitForURL(/\/admin\/security$/);
  await admin.getByRole('button', { name: 'Check now' }).click();
  const alerts = admin.getByRole('region', { name: 'Security alerts' });
  const mine = alerts.getByRole('listitem').filter({ hasText: `Helper ${tag}` }).filter({ hasText: 'Platform administrator role changed' });
  await mine.getByText(/from none to SUPPORT/).waitFor();
  await mine.getByText('Open', { exact: true }).waitFor();
  const events = admin.getByRole('table', { name: 'Security events' });
  await events.getByRole('row').filter({ hasText: `Helper ${tag}` }).first().waitFor();
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await admin.screenshot({ path: `${SHOTS}/admin-security-monitoring.png` });
  }

  await mine.getByRole('button', { name: 'Acknowledge…' }).click();
  await mine.getByLabel('What was found or done').fill('Expected: new support hire, approved by the team lead.');
  await mine.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await mine.getByText('Acknowledged', { exact: true }).waitFor();
  await mine.getByText(/Acknowledged by Security Watch Admin .*: Expected: new support hire/).waitFor();

  // Only high events when filtered.
  await admin.getByLabel('Severity').selectOption('HIGH');
  await events.getByRole('row').nth(1).waitFor();
  assert.equal(await events.getByText('Medium', { exact: true }).count(), 0);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
