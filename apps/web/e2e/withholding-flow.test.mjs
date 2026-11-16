/**
 * Browser end-to-end test for TDS and reverse charge: a GST-registered owner sets up TDS
 * with a TAN, adds the professional-fees section from the Income-tax Act 2025 template,
 * adds an advocate with a PAN, enters a legal-services bill under reverse charge with TDS
 * (the form previews the tax from the server), posts it, and records the challan from the
 * TDS register, which ties to the ledger. A bill whose TDS is deposited cannot be voided.
 * Real Next.js app → real API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
// Synthetic GSTIN and PAN built from made-up values.
const gstin = (state, pan) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('27', 'ZZZCE0011Z');
const ADVOCATE_PAN = 'ZZZPK0012Z';
let browser, page, orgId, base, billId;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);
const today = () => new Date().toISOString().slice(0, 10);

async function call(p, path, body, method = body ? 'POST' : 'GET') {
  return p.evaluate(
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
});
after(async () => browser?.close());

test('an owner sets up TDS with a TAN and adds a section from the template', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('TDS Owner');
  await page.getByLabel('Email').fill(`e2e-tds-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E TDS Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `${WEB}/orgs/${orgId}`;
  assert.equal((await call(page, `/v1/orgs/${orgId}/gst/registration`, { gstin: OWN, legalName: 'E2E TDS Traders Private Limited', effectiveFrom: `${today().slice(0, 7)}-01` }, 'PUT')).status, 200);
  assert.equal((await call(page, `/v1/orgs/${orgId}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST', gstCategory: 'TAXABLE' })).status, 201);

  await page.goto(`${base}/tax/tds-tcs`);
  await page.getByText('TDS and TCS are not set up').waitFor();
  await page.goto(`${base}/settings/tds-tcs`);
  await page.getByText('Not set up yet').waitFor();
  await page.getByRole('button', { name: 'Set up TDS and TCS' }).click();
  await page.getByLabel('TAN').fill('PNEZ1234');
  assert.equal(await page.getByRole('button', { name: 'Save settings' }).isDisabled(), true);
  await page.getByLabel('TAN').fill('pnez01234z');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('PNEZ01234Z').waitFor();
  await page.getByRole('link', { name: '2320 · TDS payable' }).waitFor();
  await page.getByRole('link', { name: '2321 · TCS payable' }).waitFor();

  await page.getByRole('button', { name: 'Add 393(1)-6(iii)(b)' }).click();
  await page.getByText('Fees for professional services').first().waitFor();
  await page.getByText('above ₹50,000 a tax year', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add 393(1)-6(iii)(b)' }).waitFor({ state: 'detached' });
  await shot(page, 'w1-tds-settings');
});

test('an advocate with a PAN and a default TDS section', async () => {
  await page.goto(`${base}/purchases/vendors`);
  await page.getByRole('button', { name: 'New vendor' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Name', { exact: true }).fill('Adv. Kiran Patil');
  await d.getByLabel('State').selectOption('27');
  await d.getByLabel('PAN').fill('ZZZPK00');
  assert.equal(await d.getByRole('button', { name: 'Save vendor' }).isDisabled(), true);
  await d.getByLabel('PAN').fill(ADVOCATE_PAN.toLowerCase());
  await d.getByText(/Decides TDS and TCS rates/).waitFor();
  await d.getByLabel('Default TDS section').selectOption({ label: 'TDS 393(1)-6(iii)(b) · Fees for professional services' });
  await shot(page, 'w2-vendor-pan');
  await d.getByRole('button', { name: 'Save vendor' }).click();
  await d.waitFor({ state: 'detached' });
  await page.getByText(`PAN ${ADVOCATE_PAN}`).waitFor();
});

test('a reverse-charge legal bill previews and posts TDS', async () => {
  await page.goto(`${base}/purchases/bills/new`);
  await page.locator('#doc-contact option', { hasText: 'Adv. Kiran Patil' }).waitFor({ state: 'attached' });
  await page.locator('#doc-contact').selectOption({ label: 'Adv. Kiran Patil' });
  await page.getByLabel('Account for line 1').selectOption({ label: '6600 · Professional Fees' });
  await page.getByLabel('Description for line 1').fill('Legal opinion on supply contracts');
  await page.getByLabel('Unit price for line 1').fill('40000');
  await page.getByLabel('HSN or SAC for line 1').fill('998211');
  await page.getByLabel('Tax for line 1').selectOption({ label: 'GST 18%' });
  await page.getByLabel(/Reverse charge/).check();
  // The vendor's default section is pre-selected; 40,000 is under the 50,000 threshold.
  assert.match(await page.getByLabel('TDS section').locator('option:checked').textContent(), /^393\(1\)-6\(iii\)\(b\)/);
  await page.getByText('TDS 10% on ₹0.00 = ₹0.00').waitFor();
  await page.getByLabel('Unit price for line 1').fill('60000');
  await page.getByText('TDS 10% on ₹60,000.00 = ₹6,000.00').waitFor();
  await page.getByText(`PAN ${ADVOCATE_PAN}.`).waitFor();
  await page.getByText('Payable to vendor').waitFor();
  await page.getByText('₹54,000.00').first().waitFor();
  await shot(page, 'w3-bill-rcm-tds-preview');
  await page.getByRole('button', { name: 'Post bill' }).click();
  await page.waitForURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  billId = page.url().split('/').pop();
  await page.getByRole('heading', { name: 'Bill BILL-000001' }).waitFor();
  const tds = page.getByLabel('TDS details');
  await tds.getByText('393(1)-6(iii)(b)').first().waitFor();
  await tds.getByText('₹6,000.00').first().waitFor();

  const bill = (await call(page, `/v1/orgs/${orgId}/purchases/documents/${billId}`)).body;
  assert.equal(bill.reverseCharge, true);
  assert.equal(bill.reverseChargeTax, '10800.00');
  assert.equal(bill.taxTotal, '0.00');
  assert.equal(bill.total, '54000.00');
  assert.equal(bill.withholding.amount, '6000.00');
  await shot(page, 'w4-bill-rcm-tds');
});

test('the TDS register ties to the ledger and a challan clears it', async () => {
  await page.goto(`${base}/tax/tds-tcs`);
  await page.getByText(/Agrees with the ledger: 2320 TDS payable is ₹6,000.00/).waitFor();
  await page.getByLabel('Select BILL-000001').check();
  await page.getByRole('button', { name: 'Record challan (1)' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Paid from').selectOption({ label: '1120 · Operating Bank Account' });
  await d.getByLabel('Challan reference').fill('CIN 0510308E2E000001 (synthetic)');
  await shot(page, 'w5-record-challan');
  await d.getByRole('button', { name: 'Record challan' }).click();
  await d.waitFor({ state: 'detached' });
  await page.getByRole('link', { name: 'TDSD-000001' }).waitFor();
  await page.getByText(/Nothing to deposit for Q\d/).waitFor();
  await page.getByText(/Agrees with the ledger: 2320 TDS payable is ₹0.00/).waitFor();
  await shot(page, 'w6-tds-register-deposited');

  const mark = consoleErrors.length;
  const voided = await call(page, `/v1/orgs/${orgId}/purchases/documents/${billId}/void`, { reason: 'Entered twice' });
  assert.equal(voided.status, 409);
  assert.equal(voided.body.error, 'TAX_DEPOSITED');
  consoleErrors.splice(mark); // the refused void logs its 409

  await page.goto(`${base}/tax/gst-returns`);
  await page.getByText('✓ Agrees with the ledger').waitFor();
  await page.getByText('(d) Inward supplies liable to reverse charge').waitFor();
  await page.getByText('(A)(3) Inward supplies liable to reverse charge').waitFor();
  await shot(page, 'w7-gstr-3b-reverse-charge');
  assert.deepEqual(consoleErrors, []);
});
