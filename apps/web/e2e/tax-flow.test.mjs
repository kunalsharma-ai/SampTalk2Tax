/**
 * Browser end-to-end test for India GST: an owner registers for GST, creates a GST
 * rate, adds a registered customer, raises an invoice whose CGST/SGST split changes
 * to IGST when the place of supply moves to another state, posts it, and reviews
 * GSTR-3B (which ties to the ledger) and GSTR-1.
 * Real Next.js app → real API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
// Synthetic GSTINs built from made-up PANs, with a computed check character.
const gstin = (state, pan) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('27', 'ZZZCE0001Z');
const CUSTOMER = gstin('27', 'ZZZCE0002Z');
let browser, page, orgId, base;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function call(p, path, body) {
  return p.evaluate(
    async ([u, b]) => {
      const r = await fetch(`/api/t2t${u}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner registers for GST and gets the six GST accounts', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('GST Owner');
  await page.getByLabel('Email').fill(`e2e-gst-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E GST Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `${WEB}/orgs/${orgId}`;

  await page.goto(`${base}/settings/gst`);
  await page.getByText('Not registered yet').waitFor();
  await page.getByRole('button', { name: 'Set up GST' }).click();
  await page.getByLabel('GSTIN').fill(OWN.slice(0, 14) + (OWN[14] === 'A' ? 'B' : 'A'));
  await page.getByText(/check character does not match/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Register for GST' }).isDisabled(), true);
  await page.getByLabel('GSTIN').fill(OWN.toLowerCase());
  await page.getByText(/State 27 · Maharashtra/).waitFor();
  await page.getByLabel('Legal name').fill('E2E GST Traders Private Limited');
  await page.getByRole('button', { name: 'Register for GST' }).click();
  await page.getByText('Where GST posts').waitFor();
  await page.getByText(OWN).waitFor();
  for (const name of ['Output CGST', 'Output SGST/UTGST', 'Output IGST', 'Input CGST', 'Input SGST/UTGST', 'Input IGST']) await page.getByRole('link', { name: new RegExp(`· ${name.replace('/', '\\/')}$`) }).waitFor();
  await shot(page, 't1-gst-settings');
});

test('GST rates and a registered customer', async () => {
  await page.goto(`${base}/settings/tax-rates`);
  await page.getByRole('button', { name: 'New tax rate' }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('Type').inputValue(), 'GST');
  await dialog.getByLabel('Name').fill('GST 18%');
  await dialog.getByLabel('Rate (%)').fill('18');
  await shot(page, 't2-new-gst-rate');
  await dialog.getByRole('button', { name: 'Save tax rate' }).click();
  await page.getByText('GST · Taxable').waitFor();
  assert.equal((await call(page, `/v1/orgs/${orgId}/tax-rates`, { name: 'Nil rated', rate: '0', kind: 'GST', gstCategory: 'NIL_RATED' })).status, 201);

  await page.goto(`${base}/sales/customers`);
  await page.getByRole('button', { name: 'New customer' }).click();
  const c = page.getByRole('dialog');
  await c.getByLabel('Name', { exact: true }).fill('Pune Retail LLP');
  await c.getByLabel('GSTIN').fill(CUSTOMER);
  await c.getByText('Registered in Maharashtra.', { exact: false }).waitFor();
  assert.equal(await c.getByLabel('State').isDisabled(), true);
  await shot(page, 't3-customer-gstin');
  await c.getByRole('button', { name: 'Save customer' }).click();
  await page.getByText(`GSTIN ${CUSTOMER}`).waitFor();
});

test('the invoice splits CGST and SGST in-state and switches to IGST across states', async () => {
  await page.goto(`${base}/sales/invoices/new`);
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Pune Retail LLP' });
  await page.getByText('Intra-state: CGST + SGST').waitFor();
  await page.getByLabel('Account for line 1').selectOption({ label: '4100 · Sales Revenue' });
  await page.getByLabel('Description for line 1').fill('Steel racks');
  await page.getByLabel('Quantity for line 1').fill('4');
  await page.getByLabel('Unit price for line 1').fill('2500');
  await page.getByLabel('Tax for line 1').selectOption({ label: 'GST 18%' });
  await page.getByText('Line 1: enter the HSN or SAC code').waitFor();
  await page.getByLabel('HSN or SAC for line 1').fill('9403');
  await page.getByText('+ CGST 9% ₹900.00').waitFor();
  await page.getByText('+ SGST 9% ₹900.00').waitFor();
  await page.getByText('₹11,800.00').waitFor();
  await shot(page, 't4-invoice-intra-state');

  await page.getByLabel('Place of supply').selectOption('29');
  await page.getByText('Inter-state: IGST').waitFor();
  await page.getByText('+ IGST 18% ₹1,800.00').waitFor();
  await page.getByLabel('Place of supply').selectOption('27');
  await page.getByText('Intra-state: CGST + SGST').waitFor();
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await page.getByRole('heading', { name: 'Invoice INV-000001' }).waitFor();
  const gst = page.getByLabel('GST details');
  await gst.getByText('27 · Maharashtra').waitFor();
  await gst.getByText(CUSTOMER).waitFor();
  await gst.getByText('CGST ₹900.00 · SGST/UTGST ₹900.00').waitFor();
  await shot(page, 't5-invoice-gst-details');
});

test('GSTR-3B ties to the ledger and GSTR-1 lists the B2B invoice', async () => {
  await page.goto(`${base}/tax/gst-returns`);
  await page.getByText('✓ Agrees with the ledger').waitFor();
  await page.getByText('3.1 Outward supplies').waitFor();
  await page.getByText('6.1 Payment of tax').waitFor();
  await shot(page, 't6-gstr-3b');
  await page.getByRole('tab', { name: 'GSTR-1' }).click();
  await page.getByText('4 B2B invoices').waitFor();
  await page.getByRole('link', { name: 'INV-000001' }).waitFor();
  await page.getByText('12 HSN summary: B2B').waitFor();
  await shot(page, 't7-gstr-1');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  await mobile.goto(`${base}/tax/gst-returns`);
  await mobile.getByText('6.1 Payment of tax').waitFor();
  await shot(mobile, 't8-gst-returns-mobile');
  await mobile.close();
  assert.deepEqual(consoleErrors, []);
});
