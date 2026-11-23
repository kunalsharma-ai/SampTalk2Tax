/**
 * Browser end-to-end test for Australian GST on the BAS (TAX-035): an owner of an Australian
 * company adds the ABN and a monthly BAS cycle, opens last month's GST items (G1, 1A, 1B) in whole
 * dollars prepared from an invoice and a bill, and records the lodgment. Real Next.js app, API and MongoDB.
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
const fyOf = (iso) => Number(iso.slice(0, 4)) + (Number(iso.slice(5, 7)) >= 7 ? 1 : 0); // not money: July years

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

test('an Australian company prepares the GST items of its BAS from the books and records the lodgment', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Mia Activity');
  await page.getByLabel('Email').fill(`e2e-au-bas-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('AU');
  await page.getByLabel('Organisation name').fill('E2E Wattle BAS Pty Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;

  // The books: last month's invoice at 10% with a GST-free line, and a bill at 10%.
  if (fyOf(D) !== fyOf(T)) await call(`${B}/periods/fiscal-years`, { fiscalYear: fyOf(D) });
  await must(call(`${B}/country-module/starter-rates`, {}));
  const rates = Object.fromEntries((await must(call(`${B}/tax-rates`))).map((r) => [r.name, r.id]));
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customer = (await must(call(`${B}/contacts`, { name: 'Synthetic Banksia Retail Pty Ltd', isCustomer: true }))).id;
  const vendor = (await must(call(`${B}/contacts`, { name: 'Synthetic Harbour Supplies Pty Ltd', isVendor: true }))).id;
  const line = (unitPrice, accountId, taxRateId) => ({ accountId, description: 'Synthetic goods', quantity: '1', unitPrice, taxRateId });
  await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: D, dueDate: D, post: true, lines: [line('1000.40', accounts['4100'], rates['GST 10%']), line('500.00', accounts['4100'], rates['GST-free 0%'])] }));
  await must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: D, dueDate: D, post: true, lines: [line('200.00', accounts['6600'], rates['GST 10%'])] }));

  await page.goto(base);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'BAS (GST)', exact: true }).click();
  await page.getByRole('heading', { name: 'Business activity statement (GST)', exact: true }).waitFor();

  // Australia's treatments and cycles: no reduced rate, no HMRC staggers.
  const treatment = page.getByLabel('GST treatment of GST 10%');
  await treatment.waitFor();
  assert.match(await treatment.locator('option').first().innerText(), /Suggested: Taxable \(10%\)/);
  assert.equal(await treatment.locator('option', { hasText: 'Reduced rate' }).count(), 0);
  assert.equal(await page.getByLabel('Return periods').locator('option').count(), 2);
  await page.getByLabel('ABN', { exact: true }).fill('51 824 753 557');
  await page.getByLabel('Registered from').fill(`${lastMonth}-01`);
  await page.getByLabel('Return periods').selectOption('MONTHLY');
  await page.getByRole('button', { name: 'Save GST registration' }).click();
  await page.getByText('That is not a valid Australian Business Number').waitFor();
  await page.getByLabel('ABN', { exact: true }).fill('51 824 753 556');
  await page.getByRole('button', { name: 'Save GST registration' }).click();
  await page.getByText(/ABN 51824753556, registered from .* · Monthly/).waitFor();

  const items = page.getByRole('table', { name: 'BAS GST items' });
  await items.waitFor();
  const item = async (label) => (await items.getByRole('row', { name: label }).innerText()).split('\t').pop().trim();
  // G1 = 1,100.44 + 500 = 1,600.44, cents left off; 1A = 100.04; 1B = 20.
  assert.match(await item(/Total sales/), /1,600$/);
  assert.match(await item(/GST on sales/), /100$/);
  assert.match(await item(/GST on purchases/), /20$/);
  assert.match(await item(/Net GST/), /80$/);
  assert.match(await page.getByTestId('vat-direction').innerText(), /^You pay the ATO .*80\.00\.$/);
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/au-gst-bas.png`, fullPage: true });

  await page.getByLabel('ATO reference').fill('SYN-BAS-1');
  await page.getByRole('button', { name: 'Record as submitted' }).click();
  await page.getByText(/Submitted to the ATO on .*, reference SYN-BAS-1\. Recorded by Mia Activity/).waitFor();
  await page.getByRole('table', { name: 'BAS periods' }).getByRole('row', { name: /Submitted.*80(\.00)? to pay/ }).waitFor();
});
