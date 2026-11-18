/**
 * Browser end-to-end test for fixed deposits: an owner places a deposit dated a year and a bit
 * back, sees what it pays at maturity as they type, accrues interest on every open deposit,
 * reverses the accrual and accrues again, and records the maturity with tax deducted.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const fyOf = (d) => (+d.slice(5, 7) >= 4 ? +d.slice(0, 4) + 1 : +d.slice(0, 4));
const START = shift(T, -400);
const MATURITY = `${+START.slice(0, 4) + 1}${START.slice(4)}`;

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
});

test('an owner places a fixed deposit, accrues its interest and records the maturity', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Deposit Owner');
  await page.getByLabel('Email').fill(`e2e-deposits-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Deposits Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const fy of new Set([fyOf(START), fyOf(MATURITY), fyOf(T)])) if (!years.has(fy)) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fy })).status, 201);

  await page.getByRole('link', { name: 'Fixed deposits', exact: true }).click();
  await page.getByRole('heading', { name: 'Fixed deposits', exact: true }).waitFor();
  await page.getByText('No deposits yet').waitFor();
  await page.getByRole('link', { name: 'Place a deposit' }).click();
  await page.getByRole('heading', { name: 'Place a deposit' }).waitFor();
  // A new chart has no deposit accounts yet: the form says what is needed.
  await page.getByText('Accounts needed').waitFor();
  for (const [code, name] of [['1160', 'Fixed Deposits'], ['1170', 'Interest Accrued on Deposits']]) {
    assert.equal((await call(`${base}/accounts`, { code, name, type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' })).status, 201);
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Place a deposit' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('One-year FD');
  await page.getByLabel('Bank or institution').fill('HDFC Bank');
  await page.getByLabel('Deposit number (optional)').fill('FD/5512');
  await page.getByLabel('Amount deposited').fill('100000');
  await page.getByLabel('Interest rate (% a year)').fill('7');
  await page.getByLabel('Start date').fill(START);
  await page.getByLabel('Maturity date').fill(MATURITY);
  await page.getByText('7,185.90').first().waitFor();
  await page.getByText('1,07,185.90').first().waitFor();
  assert.match(await page.getByLabel('Deposit account').locator('option:checked').innerText(), /1160 Fixed Deposits/);
  assert.match(await page.getByLabel('Interest accrued account').locator('option:checked').innerText(), /1170 Interest Accrued on Deposits/);
  await shot('new-deposit');
  await page.getByRole('button', { name: 'Place deposit' }).click();
  await page.waitForURL(/\/deposits\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'FD-000001 One-year FD' }).waitFor();
  await page.getByText('This deposit has matured').waitFor();

  // Accrue every open deposit from the list, to a date before maturity.
  await page.getByRole('link', { name: 'All deposits' }).click();
  await page.getByRole('table', { name: 'Deposits' }).getByText('FD-000001 One-year FD').waitFor();
  const mid = shift(START, 100);
  await page.getByLabel('Accrue interest on every open deposit to').fill(mid);
  await page.getByRole('button', { name: 'Accrue interest' }).click();
  await page.getByText('Interest accrued on 1 deposit').waitFor();
  await page.getByRole('link', { name: 'FD-000001 One-year FD' }).click();
  await page.getByRole('heading', { name: 'FD-000001 One-year FD' }).waitFor();
  const table = page.getByRole('table', { name: 'Deposit postings' });
  await table.getByText('Interest accrued').waitFor();

  // Reverse it, then accrue to maturity from the deposit itself.
  await page.getByPlaceholder('Why it is being reversed').fill('Wrong date');
  await page.getByLabel('Reverse on').fill(mid);
  await page.getByRole('button', { name: 'Reverse', exact: true }).click();
  await table.getByText('Reversed').waitFor();
  await page.getByRole('tab', { name: 'Accrue interest' }).click();
  await page.getByLabel('Accrue to').fill(MATURITY);
  await page.getByRole('button', { name: 'Accrue', exact: true }).click();
  await table.locator('tbody tr').nth(2).waitFor();
  let d = (await call(`${base}/deposits`)).body.items[0];
  assert.equal(d.accrued, '7185.90');
  assert.equal(d.accruedTo, MATURITY);

  // Record the maturity: the amount received is filled in with the maturity value; the bank deducted 10% TDS.
  await page.getByRole('tab', { name: 'Close deposit' }).click();
  await page.getByLabel('Closed on').fill(MATURITY);
  await page.getByLabel('Amount received').fill('106467.31');
  await page.getByLabel('Tax deducted (TDS)').fill('718.59');
  await page.getByLabel('Claim the tax in').waitFor();
  await page.getByText('Interest at maturity:').waitFor();
  await page.getByRole('button', { name: 'Record maturity' }).click();
  await table.getByText('Closed', { exact: true }).waitFor();
  await shot('deposit-detail');
  d = (await call(`${base}/deposits`)).body;
  assert.equal(d.items[0].status, 'CLOSED');
  assert.equal(d.totals.principal, '0.00');
  const tb = (await call(`${base}/reports/trial-balance?asOf=${T}`)).body;
  const bal = (code) => {
    const r = tb.rows.find((x) => x.code === code);
    return r ? (+r.debit - +r.credit).toFixed(2) : '0.00';
  };
  assert.equal(bal('1160'), '0.00');
  assert.equal(bal('1170'), '0.00');
  assert.equal(bal('1450'), '718.59');

  await page.getByRole('link', { name: 'All deposits' }).click();
  await page.getByRole('table', { name: 'Deposits' }).getByText('Closed').waitFor();
  await shot('deposits-list');
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
