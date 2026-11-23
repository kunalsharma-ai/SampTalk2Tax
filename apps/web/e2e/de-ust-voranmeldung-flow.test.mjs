/**
 * Browser end-to-end test for the German VAT advance return, Umsatzsteuer-Voranmeldung (TAX-031):
 * an owner of a German company adds the USt-IdNr. and a monthly cycle, opens last month's
 * Kennzahlen prepared from an invoice at 19% and 7% and a bill, and records the submission.
 * Real Next.js app, API and MongoDB.
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

test('a German company prepares its VAT advance return from the books and records the submission', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Jonas Voranmeldung');
  await page.getByLabel('Email').fill(`e2e-de-ustva-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('DE');
  await page.getByLabel('Organisation name').fill('E2E Rhein USt GmbH');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;

  // The books: last month's invoice at 19% and 7%, and a bill at 19%.
  if (fyOf(D) !== fyOf(T)) await call(`${B}/periods/fiscal-years`, { fiscalYear: fyOf(D) });
  await must(call(`${B}/country-module/starter-rates`, {}));
  const rates = Object.fromEntries((await must(call(`${B}/tax-rates`))).map((r) => [r.name, r.id]));
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customer = (await must(call(`${B}/contacts`, { name: 'Synthetic Elbe Retail GmbH', isCustomer: true }))).id;
  const vendor = (await must(call(`${B}/contacts`, { name: 'Synthetic Main Supplies GmbH', isVendor: true }))).id;
  const line = (unitPrice, accountId, taxRateId) => ({ accountId, description: 'Synthetic goods', quantity: '1', unitPrice, taxRateId });
  await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: D, dueDate: D, post: true, lines: [line('1000.80', accounts['4100'], rates['USt 19% (standard)']), line('500.00', accounts['4100'], rates['USt 7% (reduced)'])] }));
  await must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: D, dueDate: D, post: true, lines: [line('400.00', accounts['6600'], rates['USt 19% (standard)'])] }));

  await page.goto(base);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'VAT advance return (UStVA)', exact: true }).click();
  await page.getByRole('heading', { name: 'VAT advance return (UStVA)', exact: true }).waitFor();

  const treatment = page.getByLabel('VAT treatment of USt 7% (reduced)');
  await treatment.waitFor();
  assert.match(await treatment.locator('option').first().innerText(), /Suggested: Reduced \(7%\)/);
  assert.equal(await page.getByLabel('Return periods').locator('option').count(), 2);
  await page.getByLabel('USt-IdNr.', { exact: true }).fill('DE136695977');
  await page.getByLabel('Registered from').fill(`${lastMonth}-01`);
  await page.getByLabel('Return periods').selectOption('MONTHLY');
  await page.getByRole('button', { name: 'Save VAT registration' }).click();
  await page.getByText('That is not a valid German VAT identification number').waitFor();
  await page.getByLabel('USt-IdNr.', { exact: true }).fill('DE 136 695 976');
  await page.getByRole('button', { name: 'Save VAT registration' }).click();
  await page.getByText(/USt-IdNr\. DE136695976, registered from .* · Monthly/).waitFor();

  const boxes = page.getByRole('table', { name: 'Advance return Kennzahlen' });
  await boxes.waitFor();
  assert.match(await boxes.locator('tbody tr').first().innerText(), /^81\t/);
  assert.equal(await boxes.locator('tbody tr').count(), 8);
  const box = async (label) => (await boxes.getByRole('row', { name: label }).innerText()).split('\t').pop().trim();
  // Kz 81 = 1,000 (cents left off), tax 190.00; Kz 86 = 500, tax 35.00; Kz 66 = 76.00; Kz 83 = 149.00.
  assert.match(await box(/Umsätze zu 19 %/), /1,000$/);
  assert.match(await box('Tax on Kz 81'), /190\.00$/);
  assert.match(await box('Tax on Kz 86'), /35\.00$/);
  assert.match(await box(/Vorsteuer/), /76\.00$/);
  assert.match(await box(/Vorauszahlung/), /149\.00$/);
  assert.match(await page.getByTestId('vat-direction').innerText(), /^You pay the Finanzamt .*149\.00\.$/);
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/de-ust-voranmeldung.png`, fullPage: true });

  await page.getByLabel('Finanzamt reference').fill('SYN-ELSTER-1');
  await page.getByRole('button', { name: 'Record as submitted' }).click();
  await page.getByText(/Submitted to the Finanzamt on .*, reference SYN-ELSTER-1\. Recorded by Jonas Voranmeldung/).waitFor();
  await page.getByRole('table', { name: 'Advance return periods' }).getByRole('row', { name: /Submitted.*149\.00 to pay/ }).waitFor();
});
