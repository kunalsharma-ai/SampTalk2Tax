/**
 * Browser end-to-end test for GST payments (TAX-022): last month's invoices and bills give tax
 * and credit; the page sets the credit off in the CGST Act's order and shows the cash to pay;
 * an accountant-owner records the PMT-06 challan, sees it posted and on the compliance
 * calendar, and voids it. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const gstin = (state, pan) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
let browser, page, orgId, base, acc;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const back = (n) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
};
const LAST = back(1);
const fyOf = (m) => +m.slice(0, 4) + (+m.slice(5, 7) >= 4 ? 1 : 0);

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a month of GST is set off and paid by challan, shown on the calendar, and voided', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('GST Payer');
  await page.getByLabel('Email').fill(`e2e-gstpay-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E GST Payer Pvt Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  const have = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!have.has(fyOf(LAST))) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(LAST) })).status, 201);
  assert.equal((await call(`${base}/gst/registration`, { gstin: gstin('29', 'ZZZGW0001Z'), effectiveFrom: `${LAST}-01` }, 'PUT')).status, 200);
  acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const rate = (await call(`${base}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' })).body.id;
  const contact = async (name, kind, g) => (await call(`${base}/contacts`, { name, [kind]: true, gstin: g })).body.id;
  const ka = await contact('Bengaluru Retail', 'isCustomer', gstin('29', 'ZZZGW0002Z'));
  const mh = await contact('Pune Distributors', 'isCustomer', gstin('27', 'ZZZGW0003Z'));
  const tn = await contact('Chennai Components', 'isVendor', gstin('33', 'ZZZGW0004Z'));
  const doc = async (path, kind, contactId, amount, account) => {
    const r = await call(`${base}/${path}`, { kind, contactId, issueDate: `${LAST}-10`, dueDate: `${LAST}-28`, post: true, lines: [{ accountId: acc[account], description: 'Goods', quantity: '1', unitPrice: amount, taxRateId: rate, hsnCode: '8471' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  await doc('sales/documents', 'INVOICE', ka, '100000.00', '4100'); // CGST 9,000 + SGST 9,000
  await doc('sales/documents', 'INVOICE', mh, '50000.00', '4100'); // IGST 9,000
  await doc('purchases/documents', 'BILL', tn, '40000.00', '1300'); // IGST credit 7,200

  await page.getByRole('link', { name: 'GST payments', exact: true }).click();
  await page.getByRole('heading', { name: 'GST payments', exact: true }).waitFor();
  const table = page.getByRole('table', { name: 'GST to settle' });
  await table.getByRole('row', { name: /^IGST ₹9,000\.00 ₹7,200\.00 ₹0\.00 ₹1,800\.00 ₹7,200\.00 ₹0\.00$/ }).waitFor();
  await table.getByRole('row', { name: /^CGST ₹9,000\.00 ₹0\.00 ₹0\.00 ₹9,000\.00/ }).waitFor();
  await page.getByText('IGST credit against IGST ₹7,200.00').waitFor();
  await page.getByText('₹19,800.00').first().waitFor();
  await shot('gst-payments-month');

  // Record the challan: the dialog asks for the bank and CIN first.
  await page.getByRole('button', { name: 'Record payment' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Record and post' }).click();
  await dlg.getByText('Choose the bank account the challan was paid from').waitFor();
  await dlg.getByLabel('Paid from').selectOption({ value: acc['1120'] });
  await dlg.getByLabel('CPIN (optional)').fill('26292900012345');
  await dlg.getByLabel('CIN').fill('HDFC26110012345');
  await dlg.getByRole('button', { name: 'Record and post' }).click();
  await dlg.waitFor({ state: 'detached' });
  const recorded = page.getByRole('table', { name: 'GST payments recorded' });
  const row = recorded.getByRole('row').filter({ hasText: 'GSTP-000001' });
  await row.getByText('HDFC26110012345 · 26292900012345').waitFor();
  await row.getByText('₹19,800.00').waitFor();
  await page.getByText('Nothing to pay for this month').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Record payment' }).count(), 0);
  await shot('gst-payments-recorded');

  // The journal and the calendar.
  const list = (await call(`${base}/gst/payments`)).body;
  const je = (await call(`${base}/journals/${list[0].journalEntryId}`)).body;
  assert.equal(je.lines.find((l) => l.accountId === acc['1120']).credit, '19800.00');
  await page.goto(`${WEB}/orgs/${orgId}/tax/compliance`);
  await page.getByRole('heading', { name: 'Compliance calendar' }).waitFor();
  await page.getByRole('link', { name: 'GSTP-000001 · HDFC26110012345' }).first().waitFor();

  // Void it: the month's tax comes back.
  await page.goto(`${WEB}/orgs/${orgId}/tax/gst-payments`);
  await row.getByRole('button', { name: 'Void' }).click();
  const v = page.getByRole('dialog');
  await v.getByLabel('Reason').fill('Challan entered twice');
  await v.getByRole('button', { name: 'Void payment' }).click();
  await v.waitFor({ state: 'detached' });
  await row.getByText('Void', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Record payment' }).waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !e.includes('422')), []);
});
