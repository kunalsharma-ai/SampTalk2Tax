/**
 * Browser end-to-end test for KPIs and the management report: an owner posts a month of
 * activity, reads the KPIs and the figures behind one, sets a target, writes the month's
 * commentary and finalises the report. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, orgId, base, accounts, M;
const consoleErrors = [];
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  const y = +month.slice(0, 4) + Math.floor(m / 12);
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const label = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

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

test('KPIs show the month’s figures, how each is calculated, and a target set in the page', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('KPI Owner');
  await page.getByLabel('Email').fill(`e2e-kpi-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Insight Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  M = (await call(`${base}/kpis`)).body.month;
  const fy = +M.slice(0, 4) + (+M.slice(5, 7) >= 4 ? 1 : 0);
  const have = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const y of [fy - 1, fy]) if (!have.has(y)) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: y })).status, 201);
  const day = (m, d) => `${m}-${String(d).padStart(2, '0')}`;
  const cust = (await call(`${base}/contacts`, { name: 'Lotus Retail', isCustomer: true })).body;
  const vend = (await call(`${base}/contacts`, { name: 'Pine Logistics', isVendor: true })).body;
  assert.equal((await call(`${base}/journals`, { date: day(shift(M, -1), 5), post: true, memo: 'Capital', lines: [{ accountId: accounts['1120'], debit: '500000.00' }, { accountId: accounts['3100'], credit: '500000.00' }] })).status, 201);
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: cust.id, issueDate: day(M, 5), post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: '100000.00' }] })).status, 201);
  assert.equal((await call(`${base}/journals`, { date: day(M, 6), post: true, memo: 'Stock sold', lines: [{ accountId: accounts['5000'], debit: '40000.00' }, { accountId: accounts['1120'], credit: '40000.00' }] })).status, 201);
  assert.equal((await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: vend.id, issueDate: day(M, 7), reference: 'PL-1', post: true, lines: [{ accountId: accounts['6400'], quantity: '1', unitPrice: '15000.00' }] })).status, 201);

  await page.getByRole('link', { name: 'KPIs', exact: true }).click();
  await page.getByText('Revenue by customer').waitFor();
  assert.equal(await page.getByLabel('Month').inputValue(), M);
  await page.getByRole('button', { name: 'Gross margin: 60.0%' }).waitFor();
  await page.getByRole('button', { name: 'Operating margin: 45.0%' }).waitFor();
  // (4,60,000 cash + 1,00,000 receivables) ÷ 15,000 payables
  await page.getByRole('button', { name: 'Current ratio: 37.33×' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByText('Current assets ÷ current liabilities at the month end.').waitFor();
  await dlg.getByRole('row', { name: /Current assets ₹5,60,000\.00/ }).waitFor();
  await dlg.getByLabel('Should be').selectOption('AT_LEAST');
  await dlg.getByLabel(/^Target/).fill('50.5');
  await dlg.getByRole('button', { name: 'Save target' }).click();
  await dlg.getByText('Target saved.').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Current ratio: 37.33×' }).getByText('Target missed').waitFor();
  await page.getByRole('row', { name: 'Lotus Retail' }).getByText('100.0%').waitFor();
  const t = (await call(`${base}/kpis/targets`)).body;
  assert.deepEqual(t.map((x) => [x.kpi, x.comparator, x.target]), [['currentRatio', 'AT_LEAST', '50.5']]);
});

test('the management report compares the month, keeps commentary and is finalised', async () => {
  await page.getByRole('link', { name: `Management report for ${label(M)}` }).click();
  await page.getByRole('heading', { name: `Management report · ${label(M)}` }).waitFor();
  const pl = page.getByRole('table', { name: 'Profit and loss' });
  const revenue = pl.getByRole('row', { name: 'Revenue', exact: true });
  assert.match(await revenue.textContent(), /₹1,00,000\.00₹0\.00₹0\.00/);
  await pl.getByRole('row', { name: 'Net income' }).getByText('₹45,000.00').first().waitFor();
  await page.getByText('No approved budget for', { exact: false }).waitFor();

  await page.getByLabel('Commentary').fill('First trading month: one customer, margins healthy.');
  await page.getByText('Unsaved changes').waitFor();
  await page.getByRole('button', { name: 'Save commentary' }).click();
  await page.getByText('Last saved by KPI Owner.').waitFor();

  await page.getByRole('button', { name: 'Finalise' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finalise' }).click();
  await page.getByText(/Finalised by KPI Owner on/).waitFor();
  await page.getByText('Frozen with the report.').waitFor();
  assert.equal(await page.getByLabel('Commentary').count(), 0, 'no editor once final');
  await page.getByText('First trading month: one customer, margins healthy.').waitFor();

  // A late posting into the month is listed, not folded in.
  assert.equal((await call(`${base}/journals`, { date: `${M}-20`, post: true, memo: 'Late sale', lines: [{ accountId: accounts['1120'], debit: '5000.00' }, { accountId: accounts['4100'], credit: '5000.00' }] })).status, 201);
  await page.reload();
  await page.getByRole('alert').getByText(/Revenue: ₹1,00,000\.00 in the report, ₹1,05,000\.00 now/).waitFor();
  await page.getByRole('link', { name: '← All months' }).click();
  await page.getByRole('row', { name: label(M) }).getByText('Final').waitFor();
  assert.deepEqual(consoleErrors, []);
});
