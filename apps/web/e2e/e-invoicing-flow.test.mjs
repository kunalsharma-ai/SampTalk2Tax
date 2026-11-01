/**
 * Browser end-to-end test for e-invoicing: a GST-registered organisation sets up e-invoicing,
 * adds a customer with a city and PIN code, downloads the INV-01 JSON for an invoice, has a
 * wrong IRP response refused, imports the right one (QR code drawn, signature not verified),
 * sees it in the register, records the IRN's cancellation and then voids the invoice.
 * Real Next.js app → real API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 * The IRP responses are made up here: unsigned tokens with the IRP's shape.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const t = new Date().toISOString().slice(0, 10);
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const gstin = (state, pan) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('27', 'ZZZCE0201Z');
const BUYER = gstin('29', 'ZZZCE0202Z');
let browser, page, orgId, base, invoice;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

const ist = (d) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const unsigned = (data) => `e30.${Buffer.from(JSON.stringify({ data: JSON.stringify(data) })).toString('base64url')}.c2ln`;
function irpResponse(doc, over = {}) {
  const irn = createHash('sha256').update(`${doc.id}-${Math.random()}`).digest('hex');
  const qr = { SellerGstin: OWN, BuyerGstin: BUYER, DocNo: doc.number, DocTyp: 'INV', DocDt: ddmmyyyy(doc.issueDate), TotInvVal: Number(doc.total), ItemCnt: 1, MainHsnCode: '9403', Irn: irn, IrnDt: ist(new Date()), ...over };
  return { Irn: irn, AckNo: 112610000098765, AckDt: ist(new Date()), SignedInvoice: unsigned({ DocDtls: { No: doc.number } }), SignedQRCode: unsigned(qr), Status: 'ACT' };
}

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

test('e-invoicing is set up after the GST registration', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('E-invoice Owner');
  await page.getByLabel('Email').fill(`e2e-einvoice-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E E-invoice Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `${WEB}/orgs/${orgId}`;

  await page.getByRole('link', { name: 'E-invoicing settings' }).click();
  await page.getByText('Register for GST first').waitFor();
  assert.equal((await call(page, `/v1/orgs/${orgId}/gst/registration`, { gstin: OWN, legalName: 'E2E E-invoice Traders Private Limited', effectiveFrom: `${FY}-04-01` }, 'PUT')).status, 200);
  assert.equal((await call(page, `/v1/orgs/${orgId}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' })).status, 201);

  await page.reload();
  await page.getByRole('button', { name: 'Set up e-invoicing' }).click();
  assert.equal(await page.getByLabel('E-invoicing applies from').inputValue(), `${FY}-04-01`);
  await page.getByLabel('Address line 1').fill('12 MG Road');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('PIN code').fill('011001');
  await page.getByText('Six digits, not starting with 0').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save settings' }).isDisabled(), true);
  await page.getByLabel('PIN code').fill('411001');
  await page.getByLabel('IRP public key (optional)').fill('not a key');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText(/must be an RSA public key/).waitFor();
  await page.getByLabel('IRP public key (optional)').fill('');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('Seller details').waitFor();
  await page.getByText('12 MG Road, Pune, 411001').waitFor();
  await page.getByText('No IRP key; signatures not verified').waitFor();
  await shot(page, 'e1-settings');
});

test('a customer gets a city and PIN code', async () => {
  await page.goto(`${base}/sales/customers`);
  await page.getByRole('button', { name: 'New customer' }).click();
  const c = page.getByRole('dialog');
  await c.getByLabel('Name', { exact: true }).fill('Karnataka Metals LLP');
  await c.getByLabel('GSTIN').fill(BUYER);
  await c.getByLabel('Address').fill('4 Residency Road\nAshok Nagar');
  await c.getByLabel('City').fill('Bengaluru');
  await c.getByLabel('PIN code').fill('56002');
  await c.getByText('A PIN code is six digits').waitFor();
  await c.getByLabel('PIN code').fill('560025');
  await c.getByRole('button', { name: 'Save customer' }).click();
  await c.waitFor({ state: 'hidden' });
  const contacts = (await call(page, `/v1/orgs/${orgId}/contacts`)).body;
  const k = (contacts.items ?? contacts).find((x) => x.name === 'Karnataka Metals LLP');
  assert.deepEqual([k.city, k.pincode, k.address], ['Bengaluru', '560025', '4 Residency Road\nAshok Nagar']);

  const accounts = (await call(page, `/v1/orgs/${orgId}/accounts`)).body;
  const rates = (await call(page, `/v1/orgs/${orgId}/tax-rates`)).body;
  const r = await call(page, `/v1/orgs/${orgId}/sales/documents`, {
    kind: 'INVOICE',
    contactId: k.id,
    issueDate: t,
    lines: [{ accountId: accounts.find((a) => a.code === '4100').id, description: 'Steel racks', quantity: '4', unitPrice: '2500', taxRateId: rates.find((x) => x.name === 'GST 18%').id, hsnCode: '9403' }],
    post: true,
  });
  assert.equal(r.status, 201);
  invoice = r.body;
});

test('the invoice downloads its JSON and refuses a response for another invoice', async () => {
  await page.goto(`${base}/sales/invoices/${invoice.id}`);
  const panel = page.getByLabel('E-invoice');
  await panel.getByText('Ready for IRP').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download JSON for IRP' }).click()]);
  assert.equal(download.suggestedFilename(), `${invoice.number}-einvoice.json`);
  const json = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(json.Version, '1.1');
  assert.deepEqual([json.DocDtls.No, json.SellerDtls.Gstin, json.BuyerDtls.Gstin, json.BuyerDtls.Addr1, json.BuyerDtls.Addr2, json.BuyerDtls.Pin], [invoice.number, OWN, BUYER, '4 Residency Road', 'Ashok Nagar', 560025]);
  assert.deepEqual([json.ValDtls.IgstVal, json.ValDtls.TotInvVal], [1800, 11800]);

  await panel.getByRole('button', { name: 'Import IRP response…' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('IRP response (JSON)').fill('{not json');
  await d.getByText('This is not valid JSON').waitFor();
  await d.getByLabel('IRP response (JSON)').fill(JSON.stringify(irpResponse(invoice, { DocNo: 'INV-999999' })));
  await d.getByRole('button', { name: 'Record IRN' }).click();
  await d.getByText('The IRP response is not for this document').waitFor();
  await d.getByText(/The QR code is for document INV-999999/).waitFor();
  await shot(page, 'e2-import-mismatch');
  consoleErrors.length = 0; // the refused import logs a 422
});

test('the right response records the IRN and draws the QR code', async () => {
  const d = page.getByRole('dialog');
  const res = irpResponse(invoice);
  await d.getByLabel('IRP response (JSON)').fill(JSON.stringify(res, null, 2));
  await d.getByRole('button', { name: 'Record IRN' }).click();
  await d.waitFor({ state: 'hidden' });
  const panel = page.getByLabel('E-invoice');
  await panel.getByText('IRN generated').waitFor();
  await panel.getByText(res.Irn).waitFor();
  await panel.getByText('Not verified (no IRP key in settings)').waitFor();
  await panel.getByRole('img', { name: /QR code/ }).waitFor();
  await shot(page, 'e3-irn-recorded');

  await page.getByRole('button', { name: 'Void…' }).click();
  const v = page.getByRole('dialog');
  await v.getByLabel(/Reason/).fill('Wrong buyer');
  await v.getByRole('button', { name: /^Void/ }).last().click();
  await v.getByText(/has an IRN on the e-invoice portal/).waitFor();
  await v.getByRole('button', { name: /Cancel|Back|Close/ }).first().click();
  consoleErrors.length = 0; // the refused void logs a 409
});

test('the register lists it, and recording the cancellation lets the invoice be voided', async () => {
  await page.goto(`${base}/tax/e-invoices`);
  const row = page.getByRole('row', { name: new RegExp(`Invoice ${invoice.number}`) });
  await row.getByText('IRN generated').waitFor();
  assert.match(await row.textContent(), /signature not verified/);
  assert.equal(await page.getByRole('button', { name: /Download JSON \(0 selected\)/ }).isDisabled(), true);
  await shot(page, 'e4-register');

  await row.getByRole('link').click();
  await page.waitForURL(new RegExp(`/sales/invoices/${invoice.id}$`));
  await page.getByRole('button', { name: 'Record IRN cancellation…' }).click();
  const c = page.getByRole('dialog');
  await c.getByLabel('Reason').selectOption('2');
  await c.getByLabel('Remark').fill('Wrong buyer address');
  await c.getByRole('button', { name: 'Record cancellation' }).click();
  await c.waitFor({ state: 'hidden' });
  const panel = page.getByLabel('E-invoice');
  await panel.getByText('Ready for IRP').waitFor();
  await panel.getByText(/Data entry mistake: Wrong buyer address/).waitFor();

  await page.getByRole('button', { name: 'Void…' }).click();
  const v = page.getByRole('dialog');
  await v.getByLabel(/Reason/).fill('Wrong buyer');
  await v.getByRole('button', { name: /^Void/ }).last().click();
  await v.waitFor({ state: 'hidden' });
  await page.getByText(/^Voided on/).waitFor();
  await page.getByLabel('E-invoice').getByText('IRN cancelled', { exact: true }).waitFor();
  assert.deepEqual(consoleErrors, []);
});
