/**
 * Browser end-to-end test for platform administration: an administrator (given the role with the
 * real admin:grant command) finds an organisation, suspends it with a reason its owner sees,
 * announces maintenance, disables and re-enables a person, and never sees the books.
 * Real Next.js app → real API → real PostgreSQL.
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

test('an administrator suspends an organisation, announces maintenance and disables a person', async () => {
  const tag = randomUUID().slice(0, 8);
  const ownerEmail = `e2e-tenant-${tag}@example.test`;
  const owner = await register('Tenant Owner', ownerEmail);
  await owner.getByLabel('Organisation name').fill(`E2E Watched Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();

  const adminEmail = `e2e-admin-${tag}@example.test`;
  const admin = await register('E2E Platform Admin', adminEmail);
  assert.match(execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' }), /is now SUPER_ADMIN/);

  // Not an administrator: the area says so and the API refuses.
  await owner.goto(`${WEB}/admin`);
  await owner.getByText('Platform administration is only for the people who run Talk2Tax.').waitFor();

  await admin.goto(`${WEB}/admin`);
  await admin.getByRole('heading', { name: 'Platform overview' }).waitFor();
  await admin.locator('[aria-label="Administrators"]').getByText(adminEmail).waitFor();

  // Find the organisation by its owner's email and suspend it.
  await admin.getByRole('navigation', { name: 'Platform administration' }).getByRole('link', { name: 'Organisations' }).click();
  await admin.getByLabel('Search organisations').fill(ownerEmail);
  await admin.getByRole('link', { name: `E2E Watched Traders ${tag}` }).click();
  await admin.waitForURL(new RegExp(`/admin/organisations/${orgId}$`));
  await admin.locator('[aria-label="Members"]').getByText(ownerEmail).waitFor();
  await admin.getByLabel('Reason members will see').fill('Subscription payment overdue');
  await admin.getByRole('button', { name: 'Suspend' }).click();
  await admin.locator('[aria-label="Platform actions"]').getByRole('cell', { name: 'Subscription payment overdue' }).waitFor();

  // A platform role is not membership: the books stay closed to the administrator.
  const books = await admin.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/accounts`, { headers: { 'x-t2t-csrf': '1' } })).status, orgId);
  assert.equal(books, 404);

  // Announce maintenance.
  await admin.getByRole('navigation', { name: 'Platform administration' }).getByRole('link', { name: 'Announcements' }).click();
  await admin.getByLabel('Message').fill(`E2E maintenance ${tag} on Sunday 02:00 IST`);
  await admin.getByLabel('Tone').selectOption('WARNING');
  await admin.getByRole('button', { name: 'Announce' }).click();
  await admin.locator('[aria-label="All announcements"]').getByRole('row', { name: new RegExp(`E2E maintenance ${tag}`) }).getByText('Showing').waitFor();

  // The owner sees both, can still read, and cannot change anything.
  await owner.goto(`${WEB}/orgs/${orgId}/accounts`);
  await owner.getByTestId('suspended-banner').getByText(/Subscription payment overdue/).waitFor();
  await owner.getByTestId('announcement').filter({ hasText: `E2E maintenance ${tag}` }).waitFor();
  const write = await owner.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/accounts`, { method: 'POST', headers: { 'x-t2t-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ code: '9997', name: 'Blocked', type: 'EXPENSE' }) })).status, orgId);
  assert.equal(write, 423);

  // Reinstate, withdraw, and disable then re-enable the owner.
  await admin.goto(`${WEB}/admin/organisations/${orgId}`);
  await admin.getByLabel('Note (optional)').fill('Paid');
  await admin.getByRole('button', { name: 'Reinstate' }).click();
  await admin.locator('[aria-label="Status"]').getByText('Active').waitFor();
  await admin.goto(`${WEB}/admin/announcements`);
  await admin.locator('[aria-label="All announcements"]').getByRole('row', { name: new RegExp(`E2E maintenance ${tag}`) }).getByRole('button', { name: 'Withdraw' }).click();
  await admin.locator('[aria-label="All announcements"]').getByRole('row', { name: new RegExp(`E2E maintenance ${tag}`) }).getByText('Withdrawn').waitFor();

  await admin.goto(`${WEB}/admin/people`);
  await admin.getByLabel('Search people').fill(ownerEmail);
  admin.once('dialog', (d) => d.accept('Reported compromised account'));
  await admin.getByRole('button', { name: `Disable ${ownerEmail}` }).click();
  await admin.getByRole('status').getByText(/Tenant Owner is disabled; 1 session\(s\) ended/).waitFor();
  await owner.goto(`${WEB}/orgs/${orgId}`);
  await owner.waitForURL(/\/login/);
  await admin.getByRole('button', { name: `Enable ${ownerEmail}` }).click();
  await admin.getByRole('status').getByText('Tenant Owner can sign in again.').waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/40[134]|423|Failed to load resource/.test(e)), []);
});
