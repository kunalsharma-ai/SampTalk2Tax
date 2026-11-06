/**
 * Browser end-to-end test for the revenue forecast: an owner with an active contract, an open
 * order, a deal and recent sales reads the forecast by month and what it is made of, changes the
 * horizon, saves it with a note and opens the saved forecast. Real Next.js app → real API → real
 * PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (k) => { const [y, m] = T.split('-').map(Number); const t = y * 12 + (m - 1) + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the revenue forecast adds contracts, orders, deals and other sales, and is saved', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Forecast Owner');
  await page.getByLabel('Email').fill(`e2e-rf-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Forecast Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const periods = await must(call(`${B}/periods`));
  if (!periods.some((p) => p.startDate <= `${shift(-3)}-01`)) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(periods[0].startDate.slice(0, 4)) - 1 });
  const cust = {};
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods']) cust[name] = (await must(call(`${B}/contacts`, { name, isCustomer: true }))).id;
  const ct = await must(call(`${B}/sales/contracts`, { contactId: cust['Asha Traders'], title: 'Cold-room upkeep', frequency: 'MONTHLY', timing: 'ADVANCE', startDate: `${shift(1)}-01`, endDate: lastDay(shift(3)), autoRenew: false, noticeDays: 30, lines: [{ accountId: acc('4100'), description: 'Upkeep', quantity: '1', unitPrice: '10000.00' }] }));
  await must(call(`${B}/sales/contracts/${ct.id}/activate`, {}));
  await must(call(`${B}/sales/orders`, { contactId: cust['Banyan Retail'], orderDate: T, lines: [{ accountId: acc('4100'), quantity: '3', unitPrice: '5000.00' }] }));
  await must(call(`${B}/crm/deals`, { name: 'Racking', contactId: cust['Cedar Foods'], amount: '100000.00', stage: 'NEGOTIATION', expectedCloseDate: `${shift(2)}-01` }));
  for (const [k, amt] of [[-3, '30000.00'], [-1, '60000.00']]) await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: cust['Cedar Foods'], issueDate: `${shift(k)}-01`, dueDate: `${shift(k)}-28`, post: true, lines: [{ accountId: acc('4100'), quantity: '1', unitPrice: amt }] }));

  await page.goto(`${base}/sales/revenue-forecast`);
  await page.getByRole('heading', { name: 'Revenue forecast' }).waitFor();
  const table = page.getByRole('table', { name: 'Revenue forecast by month' });
  await table.locator('tbody tr').nth(11).waitFor();
  assert.equal(await table.locator('tbody tr').count(), 12);
  // This month: the order (15,000) and other sales (30,000); in two months the contract, 75% of the deal and other sales.
  await table.locator('tbody tr').nth(0).getByText('₹45,000.00').first().waitFor();
  await table.locator('tbody tr').nth(2).getByText('₹1,15,000.00').first().waitFor();
  await table.locator('tbody tr').nth(2).getByText('₹1,40,000.00').first().waitFor();
  await table.locator('tfoot').getByText('₹4,80,000.00').first().waitFor(); // 45,000 + 40,000 + 115,000 + 40,000 + 8 × 30,000
  const items = page.getByRole('table', { name: 'What the forecast is made of' });
  await items.getByRole('link', { name: 'SO-0001' }).waitFor();
  await items.getByRole('link', { name: 'DL-0001' }).waitFor();
  assert.equal(await items.getByRole('link', { name: 'CT-0001' }).count(), 3);

  await page.getByLabel('Months').selectOption('3');
  await table.locator('tbody tr').nth(2).waitFor();
  assert.equal(await table.locator('tbody tr').count(), 3);
  await table.locator('tfoot').getByText('₹2,00,000.00').first().waitFor();

  await page.getByRole('button', { name: 'Save this forecast' }).click();
  await page.getByRole('dialog').getByLabel('Note (optional)').fill('Quarter plan');
  await page.getByRole('dialog').getByRole('button', { name: 'Save forecast' }).click();
  await page.getByRole('heading', { name: 'Saved forecast RF-0001' }).waitFor();
  await page.getByText('The comparison starts once').waitFor();
  await page.getByRole('table', { name: 'Saved forecast by month' }).locator('tfoot').getByText('₹2,00,000.00').first().waitFor();

  await page.getByRole('link', { name: "Today's forecast" }).click();
  await page.getByRole('table', { name: 'Saved forecasts' }).getByRole('row', { name: /RF-0001.*Quarter plan/ }).waitFor();
  await page.getByRole('link', { name: 'Revenue forecast', exact: true }).first().waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
