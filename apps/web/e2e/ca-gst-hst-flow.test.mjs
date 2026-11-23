/**
 * Browser end-to-end test for the Canadian GST/HST return (TAX-034): an owner of a Canadian
 * company adds the business number and a monthly reporting period, opens last month's return
 * (lines 101 to 109) prepared from GST and HST invoices and a bill with revenue from the ledger,
 * and records the filing. Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const [ty, tm] = T.split('-').map(Number);
const lastMonth = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, '0')}`;
const D = `${lastMonth}-10`;
const fyOf = (iso) => Number(iso.slice(0, 4));

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => {
  const r = await p;
  assert.ok(r.status < 300, JSON.stringify(r));
  return r.body;
};

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a Canadian company prepares its GST/HST return from the books and records the filing', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Chloe Remittance');
  await page.getByLabel('Email').fill(`e2e-ca-gst-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('CA');
  await page.getByLabel('Organisation name').fill('E2E Maple GST Inc.');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;

  // The books: last month's invoice with GST and HST lines, and a bill with HST.
  if (fyOf(D) !== fyOf(T)) await call(`${B}/periods/fiscal-years`, { fiscalYear: fyOf(D) });
  await must(call(`${B}/country-module/starter-rates`, {}));
  const rates = Object.fromEntries((await must(call(`${B}/tax-rates`))).map((r) => [r.name, r.id]));
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customer = (await must(call(`${B}/contacts`, { name: 'Synthetic Lakeshore Retail Ltd', isCustomer: true }))).id;
  const vendor = (await must(call(`${B}/contacts`, { name: 'Synthetic Prairie Supplies Ltd', isVendor: true }))).id;
  const line = (unitPrice, accountId, taxRateId) => ({ accountId, description: 'Synthetic goods', quantity: '1', unitPrice, taxRateId });
  await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: D, dueDate: D, post: true, lines: [line('1000.00', accounts['4100'], rates['GST 5% (federal)']), line('2000.00', accounts['4100'], rates['HST 13% (Ontario)'])] }));
  await must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: D, dueDate: D, post: true, lines: [line('400.00', accounts['6600'], rates['HST 13% (Ontario)'])] }));

  await page.goto(base);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'GST/HST return', exact: true }).click();
  await page.getByRole('heading', { name: 'GST/HST return', exact: true }).waitFor();

  // Canada's treatments: GST and HST rates are taxable, no reduced rate.
  const treatment = page.getByLabel('GST/HST treatment of HST 13% (Ontario)');
  await treatment.waitFor();
  assert.match(await treatment.locator('option').first().innerText(), /Suggested: Taxable \(GST\/HST\)/);
  assert.equal(await treatment.locator('option', { hasText: 'Reduced rate' }).count(), 0);
  await page.getByLabel('Business number (GST/HST account)').fill('123456783 RT0001');
  await page.getByLabel('Registered from').fill(`${lastMonth}-01`);
  await page.getByLabel('Return periods').selectOption('MONTHLY');
  await page.getByRole('button', { name: 'Save GST/HST registration' }).click();
  await page.getByText('That is not a valid business number').waitFor();
  await page.getByLabel('Business number (GST/HST account)').fill('123456782 RT0001');
  await page.getByRole('button', { name: 'Save GST/HST registration' }).click();
  await page.getByText(/BN 123456782RT0001, registered from .* · Monthly/).waitFor();

  const lines = page.getByRole('table', { name: 'GST/HST return lines' });
  await lines.waitFor();
  const value = async (label) => (await lines.getByRole('row', { name: label }).innerText()).split('\t').pop().trim();
  // 101 = revenue 3,000; 103 = 50 + 260; 106 = 52; 109 = 258.
  assert.match(await value(/Sales and other revenue/), /3,000$/);
  assert.match(await value(/GST\/HST collected/), /310\.00$/);
  assert.match(await value(/Input tax credits/), /52\.00$/);
  assert.match(await value(/Net tax/), /258\.00$/);
  assert.match(await page.getByTestId('vat-direction').innerText(), /^You pay the CRA .*258\.00\.$/);
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ca-gst-hst-return.png`, fullPage: true });

  await page.getByLabel('CRA reference').fill('SYN-CRA-1');
  await page.getByRole('button', { name: 'Record as submitted' }).click();
  await page.getByText(/Submitted to the CRA on .*, reference SYN-CRA-1\. Recorded by Chloe Remittance/).waitFor();
  await page.getByRole('table', { name: 'GST/HST reporting periods' }).getByRole('row', { name: /Submitted.*258\.00 to pay/ }).waitFor();
});
