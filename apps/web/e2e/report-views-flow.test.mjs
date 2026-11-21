/**
 * Browser end-to-end test for saved report views (RPT-028, RPT-029, RPT-037): the owner saves the
 * profit and loss on the cash basis as "last month", shared, changes the filters, and opening the
 * view brings them back with last month's dates; a balance sheet view keeps "end of last month".
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a saved view brings back its filters with dates worked out on the day', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Vera Views');
  await page.getByLabel('Email').fill(`e2e-views-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Views Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();

  await page.goto(`${orgUrl}/reports/income-statement`);
  const today = await page.getByLabel('To', { exact: true }).inputValue();
  const [y, m] = today.split('-').map(Number);
  const lastMonth = { y: m === 1 ? y - 1 : y, m: m === 1 ? 12 : m - 1 };
  const lastFrom = `${lastMonth.y}-${String(lastMonth.m).padStart(2, '0')}-01`;
  const lastTo = monthEnd(lastMonth.y, lastMonth.m);

  await page.getByLabel('Basis').selectOption('CASH');
  await page.getByRole('button', { name: 'Save view' }).click();
  await page.getByLabel('View name').fill('Cash P&L last month');
  await page.getByLabel('Period when opened').selectOption('LAST_MONTH');
  await page.getByLabel('Share with everyone who can read reports').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByLabel('Saved view').getByRole('option', { name: 'Cash P&L last month (shared)' }).waitFor({ state: 'attached' });
  assert.equal(await page.getByLabel('From', { exact: true }).inputValue(), lastFrom);
  await shot('report-views-saved');

  await page.reload();
  await page.getByLabel('Saved view').getByRole('option', { name: 'Cash P&L last month (shared)' }).waitFor({ state: 'attached' });
  assert.equal(await page.getByLabel('Basis').inputValue(), 'ACCRUAL');
  await page.getByLabel('Saved view').selectOption({ label: 'Cash P&L last month (shared)' });
  assert.equal(await page.getByLabel('Basis').inputValue(), 'CASH');
  assert.equal(await page.getByLabel('From', { exact: true }).inputValue(), lastFrom);
  assert.equal(await page.getByLabel('To', { exact: true }).inputValue(), lastTo);
  await page.getByRole('heading', { name: 'Profit and loss' }).waitFor();
  await shot('report-views-opened');

  await page.goto(`${orgUrl}/reports/balance-sheet`);
  await page.getByRole('button', { name: 'Save view' }).click();
  await page.getByLabel('View name').fill('Month-end balance sheet');
  await page.getByLabel('Date when opened').selectOption('END_OF_LAST_MONTH');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByLabel('Saved view').getByRole('option', { name: 'Month-end balance sheet' }).waitFor({ state: 'attached' });
  await page.reload();
  await page.getByLabel('Saved view').getByRole('option', { name: 'Month-end balance sheet' }).waitFor({ state: 'attached' });
  await page.getByLabel('Saved view').selectOption({ label: 'Month-end balance sheet' });
  assert.equal(await page.getByLabel('As of', { exact: true }).inputValue(), lastTo);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await page.getByText('No saved views yet').waitFor({ state: 'attached' });
  assert.deepEqual(consoleErrors, []);
});
