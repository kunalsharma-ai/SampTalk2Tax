/**
 * Browser end-to-end test for cash-flow forecasting: an owner with cash, an open invoice and
 * an open bill adds planned payments in the page, sets a minimum balance and sees the
 * warning, saves the forecast, and saves a backtest from an earlier day and opens its
 * accuracy page. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, orgId, base, accounts, today;
const consoleErrors = [];
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the forecast shows cash, open invoices and bills, and planned items added in the page', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Cash Owner');
  await page.getByLabel('Email').fill(`e2e-cash-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Cash Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  today = (await call(`${base}/cash-flow/forecast?horizonDays=30`)).body.today;
  const capital = await call(`${base}/journals`, { date: addDays(today, -20), post: true, memo: 'Capital', lines: [{ accountId: accounts['1120'], debit: '100000.00' }, { accountId: accounts['4100'], credit: '100000.00' }] });
  assert.equal(capital.status, 201);
  const cust = (await call(`${base}/contacts`, { name: 'Lotus Retail', isCustomer: true })).body;
  const vend = (await call(`${base}/contacts`, { name: 'Pine Logistics', isVendor: true })).body;
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: cust.id, issueDate: addDays(today, -5), dueDate: addDays(today, 6), post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: '30000.00' }] })).status, 201);
  assert.equal((await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: vend.id, issueDate: addDays(today, -2), dueDate: addDays(today, 4), reference: 'PL-9', post: true, lines: [{ accountId: accounts['6400'], quantity: '1', unitPrice: '12000.00' }] })).status, 201);

  await page.getByRole('link', { name: 'Cash-flow forecast', exact: true }).click();
  await page.getByText('Cash today').waitFor();
  await page.getByRole('button', { name: '30 days' }).click();
  await page.waitForURL(/days=30/);
  await page.getByText('₹1,00,000.00').first().waitFor();
  await page.getByRole('row', { name: /Lotus Retail/ }).getByText('due date').waitFor();
  await page.getByRole('row', { name: /Pine Logistics/ }).waitFor();
  await page.getByText('No planned items').waitFor();

  await page.getByRole('button', { name: 'Add planned item' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Office rent');
  await dlg.getByLabel('Amount').fill('25000.555');
  await dlg.getByText('More than zero, at most 2 decimals').waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Save' }).isDisabled(), true);
  await dlg.getByLabel('Amount').fill('25000');
  await dlg.getByLabel('First date').fill(addDays(today, 2));
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('row', { name: 'Office rent' }).waitFor();
  // 1,00,000 + 30,000 − 12,000 − 25,000 (rent once in 30 days)
  await page.getByText('₹93,000.00').first().waitFor();
  const f = (await call(`${base}/cash-flow/forecast?horizonDays=30`)).body;
  assert.equal(f.closing.base, '93000.00');
  assert.deepEqual(f.planned.map((p) => [p.name, p.date]), [['Office rent', addDays(today, 2)]]);
});

test('a minimum balance warns when cash is expected to fall below it', async () => {
  const min = page.getByLabel('Minimum balance (INR)');
  await min.fill('70000');
  await page.getByRole('button', { name: 'Save minimum' }).click();
  // Lowest: 1,00,000 − 25,000 on day 2 = 75,000, then − 12,000 on day 4 = 63,000.
  const warning = page.getByText(/Cash is expected to fall below the minimum balance of ₹70,000\.00/);
  await warning.waitFor();
  const day4 = new Date(`${addDays(today, 4)}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  assert.match(await warning.textContent(), new RegExp(`on ${day4}`));
  assert.equal((await call(`${base}/cash-flow/settings`)).body.minimumBalance, '70000.00');
});

test('saves the forecast and a backtest, and the backtest shows its accuracy', async () => {
  await page.getByLabel('Note for the saved forecast').fill('E2E month start');
  await page.getByRole('button', { name: 'Save forecast' }).click();
  await page.waitForURL(/\/cash-flow\/forecasts\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: /^Forecast from/ }).waitFor();
  await page.getByText('Nothing to compare until tomorrow').waitFor();

  await page.goto(`${WEB}/orgs/${orgId}/planning/cash-flow?days=30&asOf=${addDays(today, -10)}`);
  await page.getByText('The books as they stood on', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Save backtest' }).click();
  await page.waitForURL(/\/cash-flow\/forecasts\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: /^Backtest from/ }).waitFor();
  await page.getByText('10 of 30').waitFor();
  // Nothing moved the bank in those 10 days except the planned rent the backtest assumed was not due yet.
  const id = page.url().split('/').pop();
  const saved = (await call(`${base}/cash-flow/forecasts/${id}`)).body;
  assert.equal(saved.isBacktest, true);
  assert.equal(saved.accuracy.days, 10);
  assert.equal(saved.accuracy.meanAbsoluteError, '0.00');
  await page.getByRole('link', { name: '← Cash-flow forecast' }).click();
  await page.getByText('E2E month start').waitFor();
  await page.getByRole('cell', { name: /Backtest/ }).waitFor();
  assert.deepEqual(consoleErrors, []);
});
