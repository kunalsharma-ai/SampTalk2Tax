/**
 * Browser end-to-end test for plans and subscriptions: a new organisation is on a free trial,
 * its owner asks for a plan, a platform administrator activates it on payment, and modules the
 * plan does not include are marked for upgrade. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
let browser;
const consoleErrors = [];

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
after(async () => browser?.close());

test('an owner asks for a plan and an administrator activates it on payment', async () => {
  const tag = randomUUID().slice(0, 8);
  const owner = await register('Plan Owner', `e2e-plan-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Plan Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();

  // A new organisation is on a free trial of every module.
  const nav = owner.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Subscription', exact: true }).click();
  const current = owner.locator('[aria-label="Current plan"]');
  await current.getByText('Free trial').waitFor();
  await current.getByText('Enterprise plan').waitFor();
  assert.equal(await owner.getByTestId('member-usage').innerText(), '1');

  // Ask for Growth, billed annually, in rupees.
  await owner.getByRole('button', { name: 'Annual' }).click();
  const growth = owner.locator('section[aria-label="Growth plan"]');
  assert.match(await growth.innerText(), /₹14,990\.00/);
  await growth.getByRole('button', { name: 'Choose Growth' }).click();
  await owner.getByText('Growth requested, billed annually').waitFor();
  await growth.getByRole('button', { name: 'Requested' }).waitFor();

  // A platform administrator activates it when payment arrives.
  const adminEmail = `e2e-billing-admin-${tag}@example.test`;
  const admin = await register('Billing Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });
  await admin.goto(`${WEB}/admin/subscriptions`);
  await admin.getByLabel('Show').selectOption('requested');
  admin.once('dialog', (d) => d.accept('NEFT UTR E2E-4471'));
  await admin.getByRole('button', { name: `Activate E2E Plan Traders ${tag}` }).click();
  await admin.getByRole('status').getByText(new RegExp(`E2E Plan Traders ${tag} is on Growth until`)).waitFor();

  // The owner is now on Growth: modules it lacks are marked for upgrade and refused.
  await owner.reload();
  await current.getByText('Growth plan').waitFor();
  await current.getByText('Active').waitFor();
  await owner.locator('[aria-label="Subscription history"]').getByText('ref NEFT UTR E2E-4471', { exact: false }).waitFor();
  const fxLink = nav.getByRole('link', { name: /Exchange rates/ });
  await fxLink.getByText('Upgrade').waitFor();
  assert.equal(await nav.getByRole('link', { name: /^Copilot/ }).getByText('Upgrade').count(), 0);
  const status = await owner.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/fx/rates`, { method: 'PUT', headers: { 'x-t2t-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ currency: 'USD', date: '2026-11-01', rate: '84' }) })).status, orgId);
  assert.equal(status, 403);
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
