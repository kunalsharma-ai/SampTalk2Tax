/**
 * Browser end-to-end test for enterprise contracts (SUBS-023): a platform administrator records
 * a contract for an organisation under Platform admin → Contracts, and the organisation's owner
 * sees it on the Subscription page instead of the plan chooser. Real Next.js app → real API →
 * real MongoDB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const SHOTS = process.env.SHOTS_DIR;
let browser;
let admin;
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
after(async () => {
  await browser?.close();
});

test('an administrator records an enterprise contract and the owner sees it', async () => {
  const tag = randomUUID().slice(0, 8);
  const owner = await register('Contract Owner', `e2e-contract-owner-${tag}@example.test`);
  const orgName = `E2E Contract Industries ${tag}`;
  await owner.getByLabel('Organisation name').fill(orgName);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = owner.url();

  const adminEmail = `e2e-contract-admin-${tag}@example.test`;
  admin = await register('Contract Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });
  await admin.goto(`${WEB}/admin/contracts`);
  const form = admin.locator('form[aria-label="New contract"]');
  await form.getByLabel('Organisation', { exact: true }).locator('option', { hasText: orgName }).waitFor({ state: 'attached' });
  const value = await form.getByLabel('Organisation', { exact: true }).locator('option', { hasText: orgName }).getAttribute('value');
  await form.getByLabel('Organisation', { exact: true }).selectOption(value);
  await form.getByLabel('Contract reference').fill(`ENT/E2E/${tag}`);
  await form.getByLabel('Plan', { exact: true }).selectOption('ENTERPRISE');
  await form.getByLabel('Billing', { exact: true }).selectOption('ANNUAL');
  await form.getByLabel(/Price per period/).fill('250000');
  const last = new Date(Date.now() + 330 * 60_000 + 729 * 86_400_000).toISOString().slice(0, 10);
  await form.getByLabel('Last day', { exact: true }).fill(last);
  await form.getByLabel('Members', { exact: true }).fill('200');
  await form.getByLabel('Notes', { exact: true }).fill('Two-year agreement');
  await form.getByRole('button', { name: 'Record contract' }).click();
  const row = admin.locator('[aria-label="Contracts"]').getByRole('row').filter({ hasText: `ENT/E2E/${tag}` });
  await row.getByText('In force').waitFor();
  assert.match(await row.innerText(), /₹2,50,000\.00/);
  assert.match(await row.innerText(), /Members: 200/);
  if (SHOTS) await admin.locator('main').screenshot({ path: `${SHOTS}/admin-enterprise-contracts.png` });

  // The owner sees the contract, and no plans to choose from.
  await owner.goto(`${orgUrl}/settings/subscription`);
  const note = owner.getByRole('status').filter({ hasText: `Enterprise contract ENT/E2E/${tag}` });
  await note.waitFor();
  assert.match(await note.innerText(), /₹2,50,000\.00 a year plus tax/);
  assert.equal(await owner.locator('[aria-label="Plans"]').count(), 0);
  await owner.locator('[aria-label="Current plan"]').getByText('Enterprise plan').waitFor();
  if (SHOTS) await owner.locator('main').screenshot({ path: `${SHOTS}/subscription-under-contract.png` });
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
