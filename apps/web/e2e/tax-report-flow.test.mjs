/**
 * Browser end-to-end test for tax reports (RPT-009): a GST-registered organisation with an
 * invoice and a bill at 18% last month sees output and input tax by rate and month, the GST heads
 * and its tax accounts, and downloads the report as CSV. Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const monthOf = (back) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fiscalYear = (m) => (Number(m.slice(5, 7)) >= 4 ? Number(m.slice(0, 4)) + 1 : Number(m.slice(0, 4)));
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1); // not money
    sum += Math.floor(p / 36) + (p % 36); // not money
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36];
};

let browser, page;
const consoleErrors = [];

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

test('the tax report shows tax by rate, month and account, and downloads as CSV', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Ravi Reports');
  await page.getByLabel('Email').fill(`e2e-tax-report-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Tax Report Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const LAST = monthOf(1);
  for (const fy of new Set([2, 1, 0].map((b) => fiscalYear(monthOf(b))))) await call(`${B}/periods/fiscal-years`, { fiscalYear: fy });
  consoleErrors.length = 0; // the refused years log a 409 in the console; only the page's own errors count below
  await must(call(`${B}/gst/registration`, { gstin: gstin('29ZZZTR9001Z1Z'), legalName: 'E2E Tax Report Co', effectiveFrom: `${monthOf(2)}-01` }, 'PUT'));
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const rate = (await must(call(`${B}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' }))).id;
  const customer = await must(call(`${B}/contacts`, { name: 'Bengaluru Retail', isCustomer: true, gstin: gstin('29ZZZTR9002Z1Z') }));
  const vendor = await must(call(`${B}/contacts`, { name: 'Chennai Components', isVendor: true, gstin: gstin('33ZZZTR9003Z1Z') }));
  const doc = (path, kind, contactId, account, amount) =>
    must(call(`${B}/${path}`, { kind, contactId, issueDate: `${LAST}-10`, dueDate: `${LAST}-10`, post: true, lines: [{ accountId: acc(account), description: 'Goods', quantity: '1', unitPrice: amount, taxRateId: rate, hsnCode: '8471' }] }));
  await doc('sales/documents', 'INVOICE', customer.id, '4100', '100000.00');
  await doc('purchases/documents', 'BILL', vendor.id, '6600', '40000.00');

  await page.goto(`${base}/reports/tax`);
  await page.getByLabel('From', { exact: true }).fill(`${LAST}-01`);
  await page.getByLabel('To', { exact: true }).fill(T);
  await Promise.all([page.waitForResponse((r) => r.url().includes(`/reports/tax?from=${LAST}-01`) && r.ok()), page.getByRole('button', { name: 'Show report' }).click()]);
  const rates = page.getByRole('table', { name: 'Tax by rate' });
  await rates.waitFor();
  assert.match(await rates.locator('tbody tr').first().innerText(), /18%[\s\S]*1,00,000\.00[\s\S]*18,000\.00[\s\S]*40,000\.00[\s\S]*7,200\.00[\s\S]*10,800\.00/);
  assert.match(await page.getByRole('table', { name: 'Tax by month' }).innerText(), /18,000\.00[\s\S]*7,200\.00[\s\S]*10,800\.00/);
  assert.match(await page.getByText(/GST heads/).innerText(), /Output: CGST ₹?9,000\.00, SGST ₹?9,000\.00, IGST ₹?0\.00\. Input: CGST ₹?0\.00, SGST ₹?0\.00, IGST ₹?7,200\.00/);
  const ledger = await page.getByRole('table', { name: 'Tax accounts in the ledger' }).innerText();
  assert.match(ledger, /7,200\.00/);
  assert.match(ledger, /9,000\.00/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-report.png`, fullPage: true });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download tax report (CSV)' }).click()]);
  assert.equal(download.suggestedFilename(), `tax-report-${LAST}-01-to-${T}.csv`);
  assert.deepEqual(consoleErrors, []);
});
