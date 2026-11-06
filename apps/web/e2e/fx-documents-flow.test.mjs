/**
 * Browser end-to-end test for foreign-currency documents: an invoice in USD takes the recorded
 * rate, a USD receipt at a higher rate settles it and posts a realised exchange gain, the
 * receivables ageing ties to the books in rupees, and the customer statement is in USD.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

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
  page.on('dialog', (d) => d.accept());
});
after(async () => browser?.close());

test('a USD invoice is paid at a higher rate and the gain is posted', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('FX Docs Owner');
  await page.getByLabel('Email').fill(`e2e-fxdocs-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Exporters Pvt Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const base = `/v1/orgs/${orgUrl.split('/').pop()}`;
  assert.equal((await call(`${base}/fx/rates`, { currency: 'USD', date: T, rate: '83', source: 'RBI reference rate' }, 'PUT')).status, 200);
  assert.equal((await call(`${base}/accounts`, { code: '1130', name: 'USD Bank', type: 'ASSET', subtype: 'BANK' })).status, 201);
  assert.equal((await call(`${base}/contacts`, { name: 'Acme Inc', isCustomer: true, paymentTermsDays: 30 })).status, 201);

  // The invoice in USD, at the recorded rate.
  await page.goto(`${orgUrl}/sales/invoices/new`);
  await page.locator('#doc-contact option', { hasText: 'Acme Inc' }).waitFor({ state: 'attached' });
  await page.locator('#doc-contact').selectOption({ label: 'Acme Inc' });
  await page.getByLabel('Currency').selectOption('USD');
  await page.getByText('Recorded rate on').waitFor();
  await page.getByLabel('Account for line 1').selectOption({ label: '4100 · Sales Revenue' });
  await page.getByLabel('Description for line 1').fill('Software development, October');
  await page.getByLabel('Unit price for line 1').fill('1000');
  await page.getByText('= ₹83,000.00').waitFor();
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await page.waitForURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Invoice INV-000001' }).waitFor();
  await page.getByText('at 83', { exact: false }).first().waitFor();

  // The receipt in USD at 84.50: the gain is shown before it is recorded.
  await page.getByRole('link', { name: 'Record a receipt' }).click();
  await page.waitForURL(/\/sales\/receipts\/new/);
  await page.getByLabel('Allocate to INV-000001').waitFor();
  assert.equal(await page.getByLabel('Currency').inputValue(), 'USD');
  await page.getByLabel('Deposited to').selectOption({ label: '1130 · USD Bank' });
  await page.getByLabel(/Exchange rate/).fill('84.5');
  await page.getByLabel('Amount (USD)').fill('1000');
  await page.getByRole('button', { name: 'Allocate oldest first' }).click();
  await page.getByText('Exchange gain').waitFor();
  await page.getByText('₹1,500.00').first().waitFor();
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await page.waitForURL(/\/sales\/receipts\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Receipt RCPT-000001' }).waitFor();
  await page.getByRole('cell', { name: /Gain ₹1,500.00/ }).waitFor();

  // The invoice is paid; the gain is in the books; the ageing ties.
  await page.getByRole('link', { name: 'Invoice INV-000001' }).click();
  await page.getByText('Paid', { exact: true }).first().waitFor();
  const tb = await call(`${base}/reports/trial-balance?asOf=${T}`);
  const bal = (code) => tb.body.rows.find((r) => r.code === code)?.balance;
  assert.equal(bal('7200'), '-1500.00');
  assert.equal(bal('1130'), '84500.00');
  await page.goto(`${orgUrl}/sales/ageing`);
  await page.getByText('Ties to the general ledger').waitFor();

  // The customer statement is in USD.
  const contacts = await call(`${base}/contacts?role=customer`);
  const acme = contacts.body.find((c) => c.name === 'Acme Inc');
  await page.goto(`${orgUrl}/sales/customers/${acme.id}`);
  await page.getByLabel('Statement currency').selectOption('USD');
  await page.getByRole('cell', { name: 'INV-000001' }).waitFor();
  await page.getByRole('cell', { name: '$1,000.00' }).first().waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
