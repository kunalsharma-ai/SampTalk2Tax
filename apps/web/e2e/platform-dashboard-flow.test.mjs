/**
 * Browser end-to-end test for the global super admin dashboard (DASH-042): an organisation asks
 * for a paid plan; a platform administrator (given the role with the real admin:grant command)
 * reads growth, subscriptions, usage, support and operations on the overview, follows the plan
 * request on the to-do to Subscriptions, and an owner without a platform role is kept out.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser;
const consoleErrors = [];

async function register(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
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
after(async () => browser?.close());

test('a platform administrator reads the global dashboard and follows a plan request', async () => {
  const tag = randomUUID().slice(0, 8);
  const owner = await register('Tenant Owner', `e2e-dash-tenant-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Dashboard Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();
  const asked = await owner.evaluate(
    async (id) =>
      (
        await fetch(`/api/t2t/v1/orgs/${id}/subscription/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' },
          body: JSON.stringify({ plan: 'GROWTH', interval: 'MONTHLY' }),
        })
      ).status,
    orgId,
  );
  assert.equal(asked, 201);

  const adminEmail = `e2e-dash-admin-${tag}@example.test`;
  const admin = await register('E2E Dashboard Admin', adminEmail);
  assert.match(execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' }), /is now SUPER_ADMIN/);

  // An owner without a platform role cannot read the dashboard.
  const refused = await owner.evaluate(async () => (await fetch('/api/t2t/v1/admin/dashboard', { headers: { 'x-t2t-csrf': '1' } })).status);
  assert.equal(refused, 403);
  consoleErrors.length = 0;

  await admin.goto(`${WEB}/admin`);
  await admin.getByRole('heading', { name: 'Platform overview', exact: true }).waitFor();
  const todo = admin.getByRole('list', { name: 'Platform items' });
  await todo.getByRole('link', { name: 'Plan requests waiting' }).waitFor();
  const requests = admin.getByRole('list', { name: 'Plan requests and trials ending' });
  await requests
    .getByRole('listitem')
    .filter({ hasText: `E2E Dashboard Traders ${tag}` })
    .getByText('asked for Growth, monthly')
    .waitFor();
  await admin.getByRole('img', { name: /New organisations and new people each month/ }).waitFor();
  const growth = admin.getByRole('table', { name: 'New each month' });
  await growth.getByRole('row').nth(6).waitFor();
  assert.equal(await growth.getByRole('row').count(), 7);
  await admin.getByRole('table', { name: 'Countries' }).getByRole('row', { name: /IN/ }).waitFor();
  await admin
    .getByRole('table', { name: 'Operations' })
    .getByRole('row', { name: /Error groups open/ })
    .waitFor();
  await admin.getByRole('region', { name: 'Tickets to answer' }).waitFor();
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/platform-dashboard.png`, fullPage: true });

  await todo.getByRole('link', { name: 'Plan requests waiting' }).click();
  await admin.waitForURL(/\/admin\/subscriptions$/);
  assert.deepEqual(consoleErrors, []);
});
