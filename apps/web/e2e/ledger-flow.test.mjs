/**
 * Browser end-to-end test: real Next.js app → real API → real PostgreSQL.
 * Prerequisites: API on T2T_API_URL (default :4000) and web on WEB_URL (default :3000).
 *   pnpm --filter @talk2tax/web e2e
 * Uses the `playwright` library (not @playwright/test) with Node's built-in test runner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS; // optional directory for screenshots
let browser, page;
const consoleErrors = [];
// Steps that deliberately trigger a 4xx call this so the browser's
// "Failed to load resource" log for that response is not counted as a bug.
function dropExpectedResourceErrors(fromIndex) {
  for (let i = consoleErrors.length - 1; i >= fromIndex; i--) {
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(consoleErrors[i])) consoleErrors.splice(i, 1);
  }
}

async function shot(name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

const email = `e2e-${randomUUID()}@example.test`;
const password = 'e2e-very-long-password';

test('signed-out visitors are sent to sign in', async () => {
  await page.goto(`${WEB}/journals`);
  await page.waitForURL(/\/login/);
  await shot('01-login');
});

test('register, onboard and land on an empty dashboard', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('E2E Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Trading Co');
  await shot('02-onboarding');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  await page.getByText('No posted activity yet').waitFor();
  await page.getByText('OWNER').first().waitFor();
});

test('the journal form blocks unbalanced entries and posts balanced ones', async () => {
  await page.getByRole('link', { name: 'New journal' }).first().click();
  await page.waitForURL(/journals\/new/);
  await page.getByLabel('Memo').fill('Owner capital introduced');
  await page.getByLabel('Account for line 1').selectOption({ label: '1120 · Operating Bank Account' });
  await page.getByLabel('Debit for line 1').fill('250000.00');
  await page.getByLabel('Account for line 2').selectOption({ label: '3100 · Share Capital' });
  await page.getByLabel('Credit for line 2').fill('240000.00');
  await page.getByText(/does not balance/).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Post journal' }).isDisabled(), true);
  await page.getByLabel('Credit for line 2').fill('250000.00');
  await page.getByText(/Balanced: debits equal credits/).waitFor();
  await shot('03-journal-form');
  await page.getByRole('button', { name: 'Post journal' }).click();
  await page.getByRole('heading', { name: 'Journal JE-000001' }).waitFor();
  await page.getByText('Posted', { exact: true }).waitFor();
  await shot('04-journal-posted');
});

test('the trial balance and dashboard reflect the posting', async () => {
  const orgBase = page.url().replace(/\/journals\/.*/, '');
  await page.goto(`${orgBase}/reports/trial-balance`);
  await page.getByText('✓ Balanced').waitFor();
  const footer = await page.locator('tfoot').innerText();
  assert.match(footer, /2,50,000\.00/); // INR grouping
  await shot('05-trial-balance');
  await page.goto(orgBase);
  await page.getByText('Revenue, expenses and cash by month').waitFor();
  const cash = await page.locator('text=Cash and bank').locator('..').innerText();
  assert.match(cash, /2,50,000\.00/);
  await shot('06-dashboard');
});

test('a posted journal can be reversed, never edited', async () => {
  const orgBase = page.url().replace(/\/$/, '');
  await page.goto(`${orgBase}/journals`);
  await page.getByRole('link', { name: 'JE-000001' }).click();
  assert.equal(await page.getByRole('button', { name: 'Edit' }).count(), 0);
  await page.getByRole('button', { name: 'Reverse…' }).click();
  await page.getByRole('button', { name: 'Post reversal' }).click();
  await page.getByRole('heading', { name: 'Journal JE-000002' }).waitFor();
  await page.getByText('This entry reverses another journal').waitFor();
  await page.goto(`${orgBase}/reports/trial-balance`);
  await page.getByText('No posted activity up to this date.').waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
  const footer = await page.locator('tfoot').innerText();
  assert.match(footer, /0\.00/);
});

test('a new account can be added under a header account', async () => {
  const orgBase = page.url().replace(/\/reports\/.*/, '');
  await page.goto(`${orgBase}/accounts`);
  await page.getByRole('button', { name: 'New account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Code', { exact: true }).fill('6450');
  await dialog.getByLabel('Name', { exact: true }).fill('Cloud Hosting');
  await dialog.getByLabel('Type', { exact: true }).selectOption('EXPENSE');
  await dialog.getByLabel('Subtype').selectOption('OPERATING_EXPENSE');
  await dialog.getByLabel('Parent (header) account').selectOption({ label: '6000 · Operating Expenses' });
  await dialog.getByRole('button', { name: 'Save account' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('cell', { name: 'Cloud Hosting' }).waitFor();
  // A duplicate code is refused by the server and the reason is shown.
  const mark = consoleErrors.length;
  await page.getByRole('button', { name: 'New account' }).click();
  await dialog.getByLabel('Code', { exact: true }).fill('6450');
  await dialog.getByLabel('Name', { exact: true }).fill('Duplicate');
  await dialog.getByRole('button', { name: 'Save account' }).click();
  await dialog.getByText('Could not save').waitFor();
  await page.keyboard.press('Escape');
  dropExpectedResourceErrors(mark);
});

test('locking the current period blocks posting until it is unlocked', async () => {
  const orgBase = page.url().replace(/\/accounts.*/, '');
  await page.goto(`${orgBase}/periods`);
  const row = page.getByRole('row').filter({ hasText: 'Current' });
  await row.getByRole('button', { name: 'Lock' }).click();
  await row.getByText('Locked').waitFor();
  await page.goto(`${orgBase}/journals/new`);
  await page.getByLabel('Account for line 1').selectOption({ label: '1110 · Cash on Hand' });
  await page.getByLabel('Debit for line 1').fill('10.00');
  await page.getByLabel('Account for line 2').selectOption({ label: '3100 · Share Capital' });
  await page.getByLabel('Credit for line 2').fill('10.00');
  const mark = consoleErrors.length;
  await page.getByRole('button', { name: 'Post journal' }).click();
  await page.getByText('The server rejected this journal').waitFor();
  await page.getByText(/is LOCKED/).waitFor();
  dropExpectedResourceErrors(mark);
  await page.goto(`${orgBase}/periods`);
  await page.getByRole('row').filter({ hasText: 'Current' }).getByRole('button', { name: 'Unlock' }).click();
  await page.getByRole('row').filter({ hasText: 'Current' }).getByText('Open', { exact: true }).waitFor();
});

test('the audit trail verifies', async () => {
  const orgBase = page.url().replace(/\/periods.*/, '');
  await page.goto(`${orgBase}/audit`);
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await page.getByText(/Chain intact: \d+ events verified/).waitFor();
  await shot('07-audit');
});

test('the API proxy refuses cross-site style writes without the CSRF header', async () => {
  const mark = consoleErrors.length;
  const res = await page.evaluate(async () => (await fetch('/api/t2t/v1/orgs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  assert.equal(res, 403);
  const bad = await page.evaluate(async () => (await fetch('/api/t2t/health')).status);
  assert.equal(bad, 404);
  // The browser logs those two deliberate failures; they are expected here.
  dropExpectedResourceErrors(mark);
});

test('no console errors were logged', () => {
  assert.deepEqual(consoleErrors.filter((e) => !/favicon/.test(e)), [], consoleErrors.join('\n'));
});
