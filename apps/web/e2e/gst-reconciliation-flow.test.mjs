/**
 * Browser end-to-end test for GST reconciliation (TAX-045) and tax discrepancy checks (TAX-044):
 * an organisation registered for GST posts last month's invoices and a bill, then a manual journal
 * on Output IGST and an invoice at another rate for the same HSN; the page shows the books against
 * the documents, the journal that makes the difference, and the HSN sold at two rates.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const LAST = (() => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();
let browser, page;
const consoleErrors = [];

// GSTIN check character (mod-36 Luhn), so the synthetic GSTINs are valid.
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1); // not money
    sum += Math.floor(p / 36) + (p % 36); // not money
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36];
};

async function call(path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
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

test('GST reconciliation explains the difference and finds tax mistakes', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Gita Reconcile');
  await page.getByLabel('Email').fill(`e2e-gstrec-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E GST Reconciliation Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(LAST.slice(5, 7)) >= 4 ? Number(LAST.slice(0, 4)) + 1 : Number(LAST.slice(0, 4)) });
  await must(call(`${B}/gst/registration`, { gstin: gstin('29ZZZGR9001Z1Z'), legalName: 'E2E GST Reconciliation Co', effectiveFrom: `${LAST}-01` }, 'PUT'));
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const r18 = (await must(call(`${B}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' }))).id;
  const r12 = (await must(call(`${B}/tax-rates`, { name: 'GST 12%', rate: '12', kind: 'GST' }))).id;
  const ka = (await must(call(`${B}/contacts`, { name: 'Bengaluru Retail', isCustomer: true, gstin: gstin('29ZZZGR9002Z1Z') }))).id;
  const tn = (await must(call(`${B}/contacts`, { name: 'Chennai Components', isVendor: true, gstin: gstin('33ZZZGR9003Z1Z') }))).id;
  const doc = (path, kind, contactId, day, amount, account, taxRateId) =>
    must(call(`${B}/${path}`, { kind, contactId, issueDate: `${LAST}-${day}`, dueDate: `${LAST}-${day}`, post: true, lines: [{ accountId: acc[account], description: 'Goods', quantity: '1', unitPrice: amount, taxRateId, hsnCode: '8471' }] }));
  await doc('sales/documents', 'INVOICE', ka, '10', '100000.00', '4100', r18);
  await doc('purchases/documents', 'BILL', tn, '12', '40000.00', '1300', r18);
  const cheap = await doc('sales/documents', 'INVOICE', ka, '14', '5000.00', '4100', r12);
  await must(call(`${B}/journals`, { date: `${LAST}-20`, post: true, memo: 'IGST correction', lines: [{ accountId: acc['6400'], debit: '500.00' }, { accountId: acc['2312'], credit: '500.00' }] }));
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/gst-reconciliation`);
  await page.getByRole('heading', { name: 'GST reconciliation' }).waitFor();
  await page.getByText(/The books differ from the documents for/).waitFor();
  const books = page.getByRole('table', { name: 'Books against documents' });
  assert.match(await books.getByRole('row').filter({ hasText: 'Output IGST' }).innerText(), /₹0\.00[\s\S]*₹500\.00[\s\S]*₹500\.00/);
  assert.match(await books.getByRole('row').filter({ hasText: 'Output CGST' }).innerText(), /₹9,300\.00[\s\S]*₹9,300\.00[\s\S]*₹0\.00/);
  assert.match(await books.getByRole('row').filter({ hasText: 'Input IGST' }).innerText(), /₹7,200\.00[\s\S]*₹7,200\.00/);
  const diff = page.getByRole('table', { name: 'What makes the difference' });
  assert.match(await diff.innerText(), /Journal with no document[\s\S]*\(manual: IGST correction\) moved a GST account with no document behind it[\s\S]*Output IGST[\s\S]*₹500\.00/);
  await diff.getByRole('link', { name: 'Open journal' }).waitFor();
  const mistakes = page.getByRole('table', { name: 'Tax mistakes in documents' });
  assert.match(await mistakes.innerText(), new RegExp(`HSN at different rates[\\s\\S]*HSN 8471 was sold at different rates: 12% on ${cheap.number}`));
  await page.getByText('0 high, 0 medium, 1 low').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/gst-reconciliation.png`, fullPage: true });

  // A month with nothing in it agrees.
  await page.getByLabel('Month').fill(T.slice(0, 7));
  await page.getByText(/The books agree with the documents for/).waitFor();
  await page.getByText('No tax mistakes found').waitFor();
  assert.deepEqual(consoleErrors, []);
});
