/**
 * Browser end-to-end test for the UAE VAT return, VAT 201 (TAX-033): an owner of a UAE company
 * adds the TRN, the emirate and a monthly tax period, opens last month's VAT 201 prepared from an
 * invoice and a bill, and records the submission. Real Next.js app, API and MongoDB.
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

test('a UAE company prepares its VAT 201 from the books and records the submission', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Layla Returns');
  await page.getByLabel('Email').fill(`e2e-ae-vat-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('AE');
  await page.getByLabel('Organisation name').fill('E2E Creek VAT LLC');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;

  // The books: last month's invoice at 5% with a zero-rated line, and a bill at 5%.
  if (fyOf(D) !== fyOf(T)) await call(`${B}/periods/fiscal-years`, { fiscalYear: fyOf(D) });
  await must(call(`${B}/country-module/starter-rates`, {}));
  const rates = Object.fromEntries((await must(call(`${B}/tax-rates`))).map((r) => [r.name, r.id]));
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customer = (await must(call(`${B}/contacts`, { name: 'Synthetic Marina Retail LLC', isCustomer: true }))).id;
  const vendor = (await must(call(`${B}/contacts`, { name: 'Synthetic Desert Supplies LLC', isVendor: true }))).id;
  const line = (unitPrice, accountId, taxRateId) => ({ accountId, description: 'Synthetic goods', quantity: '1', unitPrice, taxRateId });
  await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: D, dueDate: D, post: true, lines: [line('10000.00', accounts['4100'], rates['VAT 5%']), line('3000.00', accounts['4100'], rates['VAT 0% (zero-rated)'])] }));
  await must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: D, dueDate: D, post: true, lines: [line('4000.00', accounts['6600'], rates['VAT 5%'])] }));

  await page.goto(base);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'VAT return (VAT 201)', exact: true }).click();
  await page.getByRole('heading', { name: 'VAT return (VAT 201)', exact: true }).waitFor();

  const treatment = page.getByLabel('VAT treatment of VAT 5%');
  await treatment.waitFor();
  assert.match(await treatment.locator('option').first().innerText(), /Suggested: Standard-rated \(5%\)/);
  assert.equal(await treatment.locator('option', { hasText: 'Reduced rate' }).count(), 0);
  await page.getByLabel('Tax registration number (TRN)').fill('100 1234 5678 9003');
  await page.getByLabel('Registered from').fill(`${lastMonth}-01`);
  await page.getByLabel('Return periods').selectOption('MONTHLY');
  await page.getByRole('button', { name: 'Save VAT registration' }).click();
  await page.getByText('Choose the emirate your business is established in').waitFor();
  await page.getByLabel('Emirate').selectOption('DU');
  await page.getByRole('button', { name: 'Save VAT registration' }).click();
  await page.getByText(/TRN 100123456789003, registered from .* · Monthly · Dubai/).waitFor();

  const boxes = page.getByRole('table', { name: 'VAT 201 boxes' });
  await boxes.waitFor();
  // In the form's order: 1a first, 14 last.
  assert.match(await boxes.locator('tbody tr').first().innerText(), /^1a\t/);
  assert.match(await boxes.locator('tbody tr').last().innerText(), /^14\t/);
  const box = async (label) => (await boxes.getByRole('row', { name: label }).innerText()).split('\t').pop().trim();
  assert.match(await box('Standard rated supplies in Dubai: amount'), /10,000\.00$/);
  assert.match(await box('Standard rated supplies in Dubai: VAT'), /500\.00$/);
  assert.match(await box('Standard rated supplies in Abu Dhabi: amount'), /0\.00$/);
  assert.match(await box('Zero rated supplies'), /3,000\.00$/);
  assert.match(await box(/Total value of recoverable tax/), /200\.00$/);
  assert.match(await box(/Payable tax for the period/), /300\.00$/);
  assert.match(await page.getByTestId('vat-direction').innerText(), /^You pay the FTA .*300\.00\.$/);
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ae-vat-201.png`, fullPage: true });

  await page.getByLabel('FTA reference').fill('SYN-FTA-1');
  await page.getByRole('button', { name: 'Record as submitted' }).click();
  await page.getByText(/Submitted to the FTA on .*, reference SYN-FTA-1\. Recorded by Layla Returns/).waitFor();
  await page.getByRole('table', { name: 'UAE VAT tax periods' }).getByRole('row', { name: /Submitted.*300\.00 to pay/ }).waitFor();
});
