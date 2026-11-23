/**
 * Browser end-to-end test for the Singapore GST F5 return (TAX-036): an owner of a Singapore
 * company adds the GST registration, opens last month's F5 prepared from an invoice and a bill
 * with revenue from the ledger, and records the submission. Real Next.js app, API and MongoDB.
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

test('a Singapore company prepares its GST F5 from the books and records the submission', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Siew Ling Returns');
  await page.getByLabel('Email').fill(`e2e-sg-gst-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('SG');
  await page.getByLabel('Organisation name').fill('E2E Lion GST Pte Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;

  // The books: last month's invoice and bill at 9%.
  if (fyOf(D) !== fyOf(T)) await call(`${B}/periods/fiscal-years`, { fiscalYear: fyOf(D) });
  await must(call(`${B}/country-module/starter-rates`, {}));
  const standard = (await must(call(`${B}/tax-rates`))).find((r) => r.name === 'GST 9% (standard)').id;
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customer = (await must(call(`${B}/contacts`, { name: 'Synthetic Orchard Retail Pte Ltd', isCustomer: true }))).id;
  const vendor = (await must(call(`${B}/contacts`, { name: 'Synthetic Jurong Supplies Pte Ltd', isVendor: true }))).id;
  const doc = (side, kind, contactId, unitPrice, accountId) => must(call(`${B}/${side}/documents`, { kind, contactId, issueDate: D, dueDate: D, post: true, lines: [{ accountId, description: 'Synthetic goods', quantity: '1', unitPrice, taxRateId: standard }] }));
  await doc('sales', 'INVOICE', customer, '1000.00', accounts['4100']);
  await doc('purchases', 'BILL', vendor, '200.00', accounts['6600']);

  await page.goto(base);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'GST return', exact: true }).click();
  await page.getByRole('heading', { name: 'GST return (F5)', exact: true }).waitFor();

  // Singapore's treatments: no reduced rate.
  const treatment = page.getByLabel('GST treatment of GST 9% (standard)');
  await treatment.waitFor();
  assert.match(await treatment.locator('option').first().innerText(), /Suggested: Standard-rated/);
  assert.equal(await treatment.locator('option', { hasText: 'Reduced rate' }).count(), 0);
  await page.getByLabel('GST registration number').fill('GB123456782');
  await page.getByLabel('Registered from').fill(`${lastMonth}-01`);
  await page.getByLabel('Return periods').selectOption('MONTHLY');
  await page.getByRole('button', { name: 'Save GST registration' }).click();
  await page.getByText('That is not a Singapore GST registration number').waitFor();
  await page.getByLabel('GST registration number').fill('2019-12345K');
  await page.getByRole('button', { name: 'Save GST registration' }).click();
  await page.getByText(/GST number 201912345K, registered from .* · Monthly/).waitFor();

  const boxes = page.getByRole('table', { name: 'GST return boxes' });
  await boxes.waitFor();
  const box = async (label) => (await boxes.getByRole('row', { name: label }).innerText()).split('\t').pop().trim();
  assert.match(await box(/standard-rated supplies/), /1,000\.00/);
  assert.match(await box(/taxable purchases/), /200\.00/);
  assert.match(await box(/Output tax due/), /90\.00/);
  assert.match(await box(/Input tax and refunds/), /18\.00/);
  assert.match(await box(/Net GST/), /72\.00/);
  assert.match(await box(/Revenue for the accounting period/), /1,000\.00/);
  assert.match(await page.getByTestId('vat-direction').innerText(), /^You pay IRAS .*72\.00\.$/);
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sg-gst-return.png`, fullPage: true });

  await page.getByLabel('IRAS reference').fill('SYN-F5-1');
  await page.getByRole('button', { name: 'Record as submitted' }).click();
  await page.getByText(/Submitted to IRAS on .*, reference SYN-F5-1\. Recorded by Siew Ling Returns/).waitFor();
  await page.getByRole('table', { name: 'GST periods' }).getByRole('row', { name: /Submitted.*72\.00 to pay/ }).waitFor();
});
