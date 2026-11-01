/**
 * Browser end-to-end test for e-way bills: a GST-registered organisation sets up e-way bills,
 * an invoice for goods over ₹50,000 shows that one is needed, the JSON for the portal is
 * downloaded with the vehicle, the e-way bill number is recorded with its validity, the
 * vehicle is changed after a breakdown, voiding is blocked until the cancellation is
 * recorded, and the register lists it. Real Next.js app → real API → real PostgreSQL.
 * The e-way bill numbers are made up here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const t = new Date().toISOString().slice(0, 10);
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const gstin = (state, pan) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('27', 'ZZZCW0201Z');
const BUYER = gstin('29', 'ZZZCW0202Z');
const EWB = `29${String(Date.now()).slice(-10)}`;
let browser, page, orgId, base, invoice;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

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
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('e-way bills are set up after the GST registration', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('E-way Bill Owner');
  await page.getByLabel('Email').fill(`e2e-ewaybill-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Freight Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `${WEB}/orgs/${orgId}`;

  await page.getByRole('link', { name: 'E-way bill settings' }).click();
  await page.getByText('Register for GST first').waitFor();
  assert.equal((await call(page, `/v1/orgs/${orgId}/gst/registration`, { gstin: OWN, legalName: 'E2E Freight Traders Private Limited', effectiveFrom: `${FY}-04-01` }, 'PUT')).status, 200);
  assert.equal((await call(page, `/v1/orgs/${orgId}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' })).status, 201);
  await page.reload();
  await page.getByRole('button', { name: 'Set up e-way bills' }).click();
  assert.equal(await page.getByLabel('Threshold (₹)').inputValue(), '50000');
  await page.getByLabel('Dispatch address line 1').fill('Plot 7, MIDC Bhosari');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('PIN code').fill('411026');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('Dispatch from').waitFor();
  await page.getByText('Plot 7, MIDC Bhosari, Pune, 411026').waitFor();
  await shot(page, 'w1-settings');

  const c = await call(page, `/v1/orgs/${orgId}/contacts`, { name: 'Karnataka Metals LLP', isCustomer: true, gstin: BUYER, address: '4 Residency Road', city: 'Bengaluru', pincode: '560025' });
  const accounts = (await call(page, `/v1/orgs/${orgId}/accounts`)).body;
  const rates = (await call(page, `/v1/orgs/${orgId}/tax-rates`)).body;
  const r = await call(page, `/v1/orgs/${orgId}/sales/documents`, {
    kind: 'INVOICE',
    contactId: c.body.id,
    issueDate: t,
    lines: [{ accountId: accounts.find((a) => a.code === '4100').id, description: 'Steel racks', quantity: '20', unitPrice: '2500', taxRateId: rates.find((x) => x.name === 'GST 18%').id, hsnCode: '9403' }],
    post: true,
  });
  assert.equal(r.status, 201);
  invoice = r.body;
});

test('the invoice needs one: the JSON is downloaded with the vehicle and the e-way bill recorded', async () => {
  await page.goto(`${base}/sales/invoices/${invoice.id}`);
  const panel = page.getByLabel('E-way bill');
  await panel.getByText('E-way bill needed').waitFor();
  await panel.getByText(/Goods worth ₹59,000.00/).waitFor();
  await panel.getByRole('button', { name: 'Prepare e-way bill…' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Distance (km)').fill('842');
  await d.getByText('Valid for 5 day(s) from Part B').waitFor();
  await d.getByLabel('Vehicle number').fill('KA01AB12');
  await d.getByText('Not a vehicle number the portal accepts (for example MH12AB1234)').waitFor();
  assert.equal(await d.getByRole('button', { name: 'Download JSON for the portal' }).isDisabled(), true);
  await d.getByLabel('Vehicle number').fill('mh12ab1234');
  const [download] = await Promise.all([page.waitForEvent('download'), d.getByRole('button', { name: 'Download JSON for the portal' }).click()]);
  const json = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(json.version, '1.0.0621');
  const bill = json.billLists[0];
  assert.deepEqual(
    [bill.docNo, bill.fromGstin, bill.toGstin, bill.fromPincode, bill.toPincode, bill.toStateCode, bill.transMode, bill.transDistance, bill.vehicleNo, bill.igstValue, bill.totInvValue],
    [invoice.number, OWN, BUYER, 411026, 560025, 29, '1', '842', 'MH12AB1234', 9000, 59000],
  );

  await d.getByLabel('E-way bill number').fill(EWB);
  assert.match(await d.getByLabel('Valid until (IST)').inputValue(), /T23:59$/);
  await shot(page, 'w2-prepare');
  await d.getByRole('button', { name: 'Record e-way bill' }).click();
  await d.waitFor({ state: 'hidden' });
  await panel.getByText('E-way bill recorded').waitFor();
  await panel.getByText(EWB).waitFor();
  await panel.getByText('MH12AB1234').waitFor();
  await shot(page, 'w3-recorded');
});

test('the vehicle changes after a breakdown, and voiding waits for the cancellation', async () => {
  const panel = page.getByLabel('E-way bill');
  await panel.getByRole('button', { name: 'Change vehicle…' }).click();
  const v = page.getByRole('dialog');
  await v.getByLabel('Vehicle number').fill('KA01XY4321');
  await v.getByLabel('Place of change').fill('Belagavi');
  await v.getByLabel('State').selectOption('29');
  await v.getByLabel('Remark').fill('Breakdown near Belagavi');
  await v.getByRole('button', { name: 'Record Part B' }).click();
  await v.waitFor({ state: 'hidden' });
  await panel.getByRole('cell', { name: /KA01XY4321/ }).waitFor();
  await panel.getByText('Breakdown: Breakdown near Belagavi').waitFor();

  await page.getByRole('button', { name: 'Void…' }).click();
  const vd = page.getByRole('dialog');
  await vd.getByLabel(/Reason/).fill('Order cancelled');
  await vd.getByRole('button', { name: /^Void/ }).last().click();
  await vd.getByText(new RegExp(`has live e-way bill ${EWB}`)).waitFor();
  await vd.getByRole('button', { name: 'Cancel' }).click();
  consoleErrors.length = 0; // the refused void logs a 409

  await panel.getByRole('button', { name: 'Record cancellation…' }).click();
  const c = page.getByRole('dialog');
  await c.getByLabel('Reason').selectOption('2');
  await c.getByLabel('Remark').fill('Order cancelled');
  await c.getByRole('button', { name: 'Record cancellation' }).click();
  await c.waitFor({ state: 'hidden' });
  await panel.getByText('E-way bill needed').waitFor();
  await panel.getByText(/Order cancelled: Order cancelled/).waitFor();
  await page.getByRole('button', { name: 'Void…' }).click();
  const v2 = page.getByRole('dialog');
  await v2.getByLabel(/Reason/).fill('Order cancelled');
  await v2.getByRole('button', { name: /^Void/ }).last().click();
  await v2.waitFor({ state: 'hidden' });
  await page.getByText(/^Voided on/).waitFor();
  await page.getByLabel('E-way bill').getByText('Cancelled', { exact: true }).waitFor();
});

test('the register lists the invoice', async () => {
  await page.getByRole('link', { name: 'E-way bills', exact: true }).click();
  const row = page.getByRole('row', { name: new RegExp(`Invoice ${invoice.number}`) });
  await row.getByText('Cancelled', { exact: true }).waitFor();
  assert.match(await row.textContent(), /₹59,000\.00/);
  await shot(page, 'w4-register');
  assert.deepEqual(consoleErrors, []);
});
