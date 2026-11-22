/**
 * Browser end-to-end test for the tax liability forecast (TAX-048): an organisation registered for
 * GST with three months of sales sees last months' unpaid GST as known from the books, and the
 * months to come at the recent average, by month and payment. Real Next.js app → real API → real MongoDB.
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
const fy = (m) => (Number(m.slice(5, 7)) >= 4 ? Number(m.slice(0, 4)) + 1 : Number(m.slice(0, 4)));
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

test('the tax forecast shows what is owed and what is likely', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Farah Forecast');
  await page.getByLabel('Email').fill(`e2e-taxfc-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Tax Forecast Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  for (const m of [...new Set([3, 2, 1].map((b) => fy(monthOf(b))))]) await call(`${B}/periods/fiscal-years`, { fiscalYear: m });
  await must(call(`${B}/gst/registration`, { gstin: gstin('29ZZZTF9001Z1Z'), legalName: 'E2E Tax Forecast Co', effectiveFrom: `${monthOf(3)}-01` }, 'PUT'));
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const rate = (await must(call(`${B}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' }))).id;
  const ka = (await must(call(`${B}/contacts`, { name: 'Bengaluru Retail', isCustomer: true, gstin: gstin('29ZZZTF9002Z1Z') }))).id;
  for (const back of [3, 2, 1]) {
    const d = `${monthOf(back)}-10`;
    await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: ka, issueDate: d, dueDate: d, post: true, lines: [{ accountId: acc['4100'], description: 'Goods', quantity: '1', unitPrice: '100000.00', taxRateId: rate, hsnCode: '8471' }] }));
  }
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/forecast`);
  await page.getByRole('heading', { name: 'Tax forecast' }).waitFor();
  const each = page.getByRole('table', { name: 'Each payment' });
  await each.waitFor();
  // Three months of CGST + SGST 18,000, none paid: one running balance on last month's return.
  const known = each.getByRole('row').filter({ hasText: 'From the books' });
  assert.equal(await known.count(), 1);
  assert.match(await known.innerText(), /GSTR-3B[\s\S]*Includes [\s\S]*not paid yet[\s\S]*₹54,000\.00/);
  const avg = each.getByRole('row').filter({ hasText: 'Recent average' }).first();
  assert.match(await avg.innerText(), /Average of the last 3 periods \(₹18,000\.00, ₹18,000\.00, ₹18,000\.00\)[\s\S]*₹18,000\.00/);
  await page.getByRole('table', { name: 'Tax due by month' }).getByRole('row').nth(1).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-forecast.png`, fullPage: true });

  // One month ahead shows fewer payments.
  const before = await each.getByRole('row').count();
  await page.getByLabel('Months ahead').selectOption('1');
  await page.waitForFunction((n) => document.querySelectorAll('table[aria-label="Each payment"] tbody tr').length < n - 1, before);
  assert.deepEqual(consoleErrors, []);
});
