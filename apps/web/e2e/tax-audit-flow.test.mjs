/**
 * Browser end-to-end test for tax audit support (TAX-026): for the financial year 2026-27 a
 * company with 1.2 crore of sales and heavy cash spending needs a tax audit; the page shows the
 * cash paid to one supplier in a day over 10,000, a cash receipt of 2.5 lakh, TDS deposited late
 * with interest, and spending by the supplier's GST registration.
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

// GSTIN check character (mod-36 Luhn), so the synthetic GSTIN is valid.
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

test('Tax audit shows the Form 3CD working papers for the year', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Audit');
  await page.getByLabel('Email').fill(`e2e-taxaudit-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Tax Audit Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  await call(`${B}/periods/fiscal-years`, { fiscalYear: 2027 });
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  await must(call(`${B}/withholding/settings`, { tan: 'PNEZ12345B' }, 'PUT'));
  const section = await must(call(`${B}/withholding/sections`, { template: '393(1)-6(i)' }));
  const customer = (await must(call(`${B}/contacts`, { name: 'Big Buyer Ltd', isCustomer: true }))).id;
  const builder = (await must(call(`${B}/contacts`, { name: 'Sharp Builders', isVendor: true, gstin: gstin('27ZZZCA0001Z1Z'), withholdingSectionId: section.id }))).id;
  const kirana = (await must(call(`${B}/contacts`, { name: 'Local Kirana', isVendor: true }))).id;
  await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: '2026-05-05', dueDate: '2026-05-05', post: true, lines: [{ accountId: acc['4100'], description: 'Goods', quantity: '1', unitPrice: '12000000.00' }] }));
  const bill = await must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: builder, issueDate: '2026-05-10', dueDate: '2026-06-10', withholdingSectionId: section.id, post: true, lines: [{ accountId: acc['6600'], description: 'Civil work', quantity: '1', unitPrice: '50000.00' }] }));
  await must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: kirana, issueDate: '2026-05-12', dueDate: '2026-05-12', post: true, lines: [{ accountId: acc['6600'], description: 'Supplies', quantity: '1', unitPrice: '20000.00' }] }));
  const pay = (path, contactId, date, account, amount) => must(call(`${B}/${path}`, { contactId, date, bankAccountId: acc[account], amount, allocations: [] }));
  await pay('sales/payments', customer, '2026-06-01', '1110', '250000.00');
  await pay('sales/payments', customer, '2026-06-02', '1120', '10000000.00');
  await pay('purchases/payments', kirana, '2026-06-03', '1110', '6000.00');
  await pay('purchases/payments', kirana, '2026-06-03', '1110', '5000.00');
  await pay('purchases/payments', builder, '2026-06-04', '1110', '9000.00');
  await pay('purchases/payments', builder, '2026-06-05', '1120', '100000.00');
  await must(call(`${B}/withholding/deposits`, { kind: 'TDS', depositDate: '2026-07-15', bankAccountId: acc['1120'], challanReference: 'CIN 0510001-15072026-00042', documentIds: [bill.id] }));
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/tax-audit`);
  await page.getByRole('heading', { name: 'Tax audit' }).waitFor();
  await page.getByLabel('Financial year').selectOption('2026-27');
  const need = page.getByRole('region', { name: 'Is a tax audit needed' });
  await need.getByText('Tax audit needed', { exact: true }).waitFor();
  assert.match(await need.innerText(), /₹1,20,00,000\.00[\s\S]*2\.44%[\s\S]*16\.67%[\s\S]*Cash is more than 5% of payments \(16\.67%\), so the 1 crore limit applies/);
  assert.match(await page.getByRole('table', { name: 'Cash spending over 10,000 a day' }).innerText(), /Local Kirana[\s\S]*₹11,000\.00/);
  assert.match(await page.getByRole('table', { name: 'Cash received of 2 lakh or more' }).innerText(), /Big Buyer Ltd[\s\S]*₹2,50,000\.00/);
  assert.match(await page.getByRole('table', { name: 'TDS deposited late' }).innerText(), /Sharp Builders[\s\S]*393\(1\)-6\(i\)[\s\S]*15 Jul 2026[\s\S]*₹1,000\.00[\s\S]*3[\s\S]*₹45\.00/);
  assert.match(await page.getByRole('table', { name: 'Spending by GST registration' }).innerText(), /Registered for GST\s*₹50,000\.00[\s\S]*Not registered\s*₹20,000\.00[\s\S]*Total\s*₹70,000\.00/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-audit.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
