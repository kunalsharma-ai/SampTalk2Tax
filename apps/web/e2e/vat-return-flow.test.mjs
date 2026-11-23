/**
 * Browser end-to-end test for the UK VAT return (TAX-030): an owner of a UK company adds the VAT
 * registration, opens last month's return prepared from an invoice, a credit note and a bill,
 * sees the VAT paid to HMRC listed as another entry on the VAT accounts, and records the
 * submission. Real Next.js app, API and MongoDB.
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
const fyOf = (iso) => (Number(iso.slice(5, 7)) >= 4 ? Number(iso.slice(0, 4)) + 1 : Number(iso.slice(0, 4)));

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

test('a UK company prepares its VAT return from the books and records the submission', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Vera Returns');
  await page.getByLabel('Email').fill(`e2e-vat-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('GB');
  await page.getByLabel('Organisation name').fill('E2E VAT Traders Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;

  // The books: last month's invoice, credit note and bill, and VAT paid to HMRC.
  // Last month may fall in the previous financial year (409 when it already exists).
  if (fyOf(D) !== fyOf(T)) await call(`${B}/periods/fiscal-years`, { fiscalYear: fyOf(D) });
  await must(call(`${B}/country-module/starter-rates`, {}));
  const rates = await must(call(`${B}/tax-rates`));
  const standard = rates.find((r) => r.name === 'VAT 20% (standard)').id;
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customer = (await must(call(`${B}/contacts`, { name: 'Synthetic Shops Ltd', isCustomer: true }))).id;
  const vendor = (await must(call(`${B}/contacts`, { name: 'Synthetic Supplies Ltd', isVendor: true }))).id;
  const doc = (side, kind, contactId, unitPrice, accountId) => must(call(`${B}/${side}/documents`, { kind, contactId, issueDate: D, dueDate: D, post: true, lines: [{ accountId, description: 'Synthetic goods', quantity: '1', unitPrice, taxRateId: standard }] }));
  await doc('sales', 'INVOICE', customer, '1000.00', accounts['4100']);
  await doc('sales', 'CREDIT_NOTE', customer, '100.00', accounts['4100']);
  await doc('purchases', 'BILL', vendor, '200.00', accounts['6600']);
  await must(call(`${B}/journals`, { date: `${lastMonth}-20`, post: true, memo: 'Synthetic VAT payment to HMRC', lines: [{ accountId: accounts['2300'], debit: '50.00' }, { accountId: accounts['1120'], credit: '50.00' }] }));

  await page.goto(base);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'VAT return', exact: true }).click();
  await page.getByRole('heading', { name: 'VAT return', exact: true }).waitFor();

  // The registration: the number is checked, rates at 20% are suggested as standard.
  const rateTable = page.getByRole('table', { name: 'VAT treatment of tax rates' });
  await rateTable.waitFor();
  assert.match(await page.getByLabel('VAT treatment of VAT 20% (standard)').locator('option').first().innerText(), /Suggested: Standard rate/);
  await page.getByLabel('VAT registration number').fill('123456783');
  await page.getByLabel('Registered from').fill(`${lastMonth}-01`);
  await page.getByLabel('Return periods').selectOption('MONTHLY');
  await page.getByRole('button', { name: 'Save VAT registration' }).click();
  await page.getByText('That is not a valid UK VAT registration number').waitFor();
  await page.getByLabel('VAT registration number').fill('GB 123 4567 82');
  await page.getByRole('button', { name: 'Save VAT registration' }).click();
  await page.getByText(/VAT number GB123456782, registered from .* · Monthly/).waitFor();

  // Last month's return opens by itself.
  const boxes = page.getByRole('table', { name: 'VAT return boxes' });
  await boxes.waitFor();
  const box = async (n) => (await boxes.locator('tbody tr').nth(n - 1).innerText()).split('\t').pop().trim();
  assert.match(await box(1), /180\.00/);
  assert.match(await box(4), /40\.00/);
  assert.match(await box(5), /140\.00/);
  assert.equal(await box(6), '£900');
  assert.equal(await box(7), '£200');
  assert.equal(await page.getByTestId('vat-direction').innerText(), 'You pay HMRC £140.00.');
  const other = page.getByRole('table', { name: 'Other entries on the VAT accounts' });
  await other.getByText('Synthetic VAT payment to HMRC').waitFor();
  const entries = page.getByRole('table', { name: 'Entries on the return' });
  assert.equal(await entries.locator('tbody tr').count(), 3);
  assert.match(await entries.getByRole('row', { name: /Credit note/ }).innerText(), /-£100\.00[\s\S]*-£20\.00/);
  // Only periods since the registration.
  assert.equal(await page.getByRole('table', { name: 'VAT periods' }).locator('tbody tr').count(), 2);
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/vat-return.png`, fullPage: true });

  // Record the submission: the boxes are then kept as submitted.
  await page.getByLabel('HMRC reference').fill('SYN-123456');
  await page.getByRole('button', { name: 'Record as submitted' }).click();
  await page.getByText(/Submitted to HMRC on .*, reference SYN-123456\. Recorded by Vera Returns/).waitFor();
  const periods = page.getByRole('table', { name: 'VAT periods' });
  await periods.getByRole('row', { name: /Submitted.*140\.00 to pay/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Record as submitted' }).count(), 0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/vat-return-submitted.png`, fullPage: true });
});
