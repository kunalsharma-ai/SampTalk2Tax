/**
 * Browser end-to-end test for the internal controls register (AUDIT-008, AUDIT-013): the owner adds
 * a library control owned by the accountant and writes one of their own; checks the books for the
 * last month and records the test; cannot test the control they own while someone else can.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.T2T_API_URL ?? 'http://localhost:4000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const password = 'e2e-very-long-password';
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('controls are owned, checked against the books and tested by someone else', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Chitra Controls');
  await page.getByLabel('Email').fill(`e2e-controls-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Controls Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const orgId = orgUrl.split('/').pop();
  const accountantEmail = `e2e-controls-acc-${randomUUID()}@example.test`;
  assert.equal((await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: accountantEmail, name: 'Kabir Accountant', password }) })).status, 201);
  const added = await page.evaluate(async ([id, email]) => (await fetch(`/api/t2t/v1/orgs/${id}/members`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ email, role: 'ACCOUNTANT' }) })).status, [orgId, accountantEmail]);
  assert.equal(added, 201);

  await page.goto(`${orgUrl}/controls`);
  await page.getByText('No controls yet').waitFor();
  await page.getByLabel('Library control').selectOption({ label: 'Closed months locked' });
  await page.getByText('Automatic check: every accounting period').waitFor();
  await page.getByLabel('Owner', { exact: true }).selectOption({ label: 'Kabir Accountant (Accountant)' });
  await page.getByRole('button', { name: 'Add to register' }).click();
  const register = page.getByRole('table', { name: 'Controls' });
  await register.getByRole('link', { name: 'Closed months locked' }).waitFor();

  await page.getByLabel('Control title').fill('Payroll changes approved');
  await page.getByLabel('Objective').fill('Salary changes are approved before the pay run.');
  await page.getByLabel('Area').selectOption('PAYROLL');
  await page.getByLabel('Control owner').selectOption({ label: 'Chitra Controls' });
  await page.getByRole('button', { name: 'Add control' }).click();
  await register.getByRole('link', { name: 'Payroll changes approved' }).waitFor();
  assert.equal(await register.getByText('Never tested').count(), 2);

  // The owner tests the accountant's control against the books.
  await register.getByRole('link', { name: 'Closed months locked' }).click();
  await page.getByRole('heading', { name: 'Closed months locked' }).waitFor();
  await page.getByRole('button', { name: 'Run check' }).click();
  await page.getByLabel('Check outcome').getByText(/accounting periods that had ended checked/).waitFor();
  await page.getByRole('button', { name: 'Record test' }).click();
  const history = page.getByRole('table', { name: 'Test history' });
  await history.getByText('Checked against the books').waitFor();
  await history.getByText('Chitra Controls', { exact: false }).waitFor();
  await shot('controls-test-recorded');

  // The owner cannot test their own control while the accountant can.
  await page.getByRole('link', { name: 'All controls' }).click();
  await register.getByRole('link', { name: 'Payroll changes approved' }).click();
  await page.getByText('Someone other than its owner must test it.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Record test' }).count(), 0);
  await page.getByRole('link', { name: 'All controls' }).click();
  await register.getByText(/^(Passed|Failed) for /).waitFor();
  await shot('controls-register');
  assert.deepEqual(consoleErrors, []);
});
