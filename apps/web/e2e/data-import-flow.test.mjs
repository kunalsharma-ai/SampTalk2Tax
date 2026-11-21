/**
 * Browser end-to-end test for data import (UX-009 to UX-012): the owner uploads a chart of
 * accounts with a mistake, sees the problem on its row in the preview, fixes it and imports;
 * then imports customers from a pasted sheet with their own headings, and opening balances by
 * account code. Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function call(path) {
  return page.evaluate(async (u) => {
    const r = await fetch(`/api/t2t${u}`, { headers: { 'x-t2t-csrf': '1' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, path);
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a chart of accounts, customers and opening balances come in from CSV after a preview', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Ira Importer');
  await page.getByLabel('Email').fill(`e2e-import-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Import Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const periods = (await call(`/v1/orgs/${orgId}/periods`)).body;
  const fyStart = periods.map((p) => p.startDate).sort()[0];

  await page.getByRole('link', { name: 'Import data' }).first().click();
  await page.waitForURL(/\/import$/);
  await page.getByRole('heading', { name: 'Import data' }).waitFor();

  // A chart with a bad type on one row: the preview names the row and the column, and Import stays off.
  const chart = ['Account Number,Account Name,Class,Parent,Is header', 'X900,Technology,Expense,,Yes', 'X910,Cloud hosting,Expens,X900,No'].join('\n');
  await page.getByLabel('CSV file').setInputFiles({ name: 'chart.csv', mimeType: 'text/csv', buffer: Buffer.from(chart) });
  await page.getByText('Read from chart.csv.').waitFor();
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByText('Type: "Expens" is not a type').waitFor();
  assert.equal(await page.getByRole('button', { name: /^Import/ }).isDisabled(), true);
  await shot('data-import-problem');

  await page.getByLabel('Or paste the rows').fill(chart.replace('Expens,', 'Expense,'));
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByText('2 rows read: 2 to create, 0 skipped, 0 problems.').waitFor();
  await shot('data-import-preview');
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await page.getByText('Imported 2 rows').waitFor();
  const accounts = (await call(`/v1/orgs/${orgId}/accounts`)).body;
  const header = accounts.find((a) => a.code === 'X900');
  assert.equal(accounts.find((a) => a.code === 'X910').parentId, header.id);

  // Customers from a pasted sheet with its own headings; the same file again skips them.
  await page.getByRole('button', { name: 'Customers' }).click();
  const customers = ['Customer name,E-mail,GST number,Terms', 'Asha Traders,accounts@asha.example,27AAPFU0939F1ZV,45', 'Kiran Stores,,,'].join('\n');
  await page.getByLabel('Or paste the rows').fill(customers);
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await page.getByText('Imported 2 rows').waitFor();
  await page.getByLabel('Or paste the rows').fill(customers);
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByText('Asha Traders is already in your contacts').waitFor();
  const asha = (await call(`/v1/orgs/${orgId}/contacts?role=customer`)).body.find((c) => c.name === 'Asha Traders');
  assert.equal(asha.gstin, '27AAPFU0939F1ZV');
  assert.equal(asha.paymentTermsDays, 45);

  // Opening balances by code: the difference is shown before posting.
  await page.getByRole('button', { name: 'Opening balances' }).click();
  await page.getByLabel('Or paste the rows').fill(['Account code,Debit,Credit', '1120,"2,50,000",', '3100,,200000'].join('\n'));
  await page.getByLabel('Opening balance date').fill(fyStart);
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByText(/A difference of ₹50,000.00 goes to Opening Balance Equity/).waitFor();
  await shot('data-import-opening-balances');
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await page.getByText('Imported 2 rows').waitFor();
  const ob = (await call(`/v1/orgs/${orgId}/opening-balances`)).body;
  assert.deepEqual(ob.current.balances.map((b) => [b.accountCode, b.debit, b.credit]), [['1120', '250000.00', '0.00'], ['3100', '0.00', '200000.00']]);
  assert.deepEqual(consoleErrors, []);
});
