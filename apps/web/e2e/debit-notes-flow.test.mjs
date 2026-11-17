/**
 * Browser end-to-end test for debit notes (AR-017): a GST-registered owner raises a debit note on
 * a posted invoice from the invoice page (customer, currency and place of supply follow the
 * invoice), posts it as DN-000001, sees the link both ways and in the invoices list, cannot void
 * the invoice while it stands, finds it in GSTR-1 table 9B as type D and in table 13 as its own
 * series, and prints it titled "Debit note" against the invoice.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const FY = Number(T.slice(5, 7)) >= 4 ? Number(T.slice(0, 4)) : Number(T.slice(0, 4)) - 1;
const gstin = (state, pan) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('27', 'ZZZCD0301Z');
const BUYER = gstin('29', 'ZZZCD0302Z');
let browser, page;
const consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
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

test('a debit note raises an invoice, is reported in GSTR-1 and prints against the invoice', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Debit Note Owner');
  await page.getByLabel('Email').fill(`e2e-debit-notes-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Debit Notes Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  assert.equal((await call(`${B}/gst/registration`, { gstin: OWN, legalName: 'E2E Debit Notes Traders Private Limited', effectiveFrom: `${FY}-04-01` }, 'PUT')).status, 200);
  const g18 = (await call(`${B}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' })).body;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Bengaluru Fixtures', isCustomer: true, gstin: BUYER })).body;
  const inv = (await call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, post: true, lines: [{ accountId: acc['4100'], description: 'Office chairs', quantity: '20', unitPrice: '4000', taxRateId: g18.id, hsnCode: '9401' }] })).body;
  assert.equal(inv.number, 'INV-000001');

  // Raise it from the invoice.
  await page.goto(`${O}/sales/invoices/${inv.id}`);
  await page.getByRole('link', { name: 'Raise debit note…' }).click();
  await page.waitForURL(/invoices\/new\?debitNoteFor=/);
  await page.getByRole('heading', { name: 'New debit note on INV-000001' }).waitFor();
  await page.getByText('Inter-state: IGST').waitFor();
  assert.equal(await page.locator('#doc-contact').isDisabled(), true);
  assert.equal(await page.locator('#doc-contact').inputValue(), customer.id);
  await page.getByLabel('Account for line 1').selectOption(acc['4100']);
  await page.getByLabel('Description for line 1').fill('Price revision: steel surcharge');
  await page.getByLabel('Unit price for line 1').fill('3000');
  await page.getByLabel('HSN or SAC for line 1').fill('9401');
  await page.getByLabel('Tax for line 1').selectOption(g18.id);
  await page.getByRole('button', { name: 'Post debit note' }).click();
  await page.getByRole('heading', { name: 'Debit note DN-000001' }).waitFor();
  await page.getByText('Raises the value of').waitFor();
  await page.getByRole('link', { name: 'invoice INV-000001' }).click();
  await page.getByRole('heading', { name: 'Invoice INV-000001' }).waitFor();
  await page.getByText('Debit notes on this invoice:').waitFor();
  await page.getByRole('link', { name: 'DN-000001' }).waitFor();

  // The invoice cannot be voided while the debit note stands.
  await page.getByRole('button', { name: 'Void…' }).click();
  await page.getByLabel('Reason').fill('Wrong customer');
  await page.getByRole('button', { name: 'Void invoice' }).click();
  await page.getByText(/has a debit note \(DN-000001\); void or delete it first/).waitFor();
  await page.keyboard.press('Escape');

  // In the invoices list.
  await page.goto(`${O}/sales/invoices`);
  await page.getByRole('row', { name: /DN-000001.*Debit note.*Bengaluru Fixtures/ }).waitFor();

  // GSTR-1: table 9B as D, table 13 as its own series.
  await page.goto(`${O}/tax/gst-returns?month=${T.slice(0, 7)}&return=gstr-1`);
  await page.getByText('9B Credit and debit notes to registered persons').waitFor();
  await page.getByText('Debit note on INV-000001').waitFor();
  await page.getByRole('row', { name: /Debit notes.*DN-000001.*DN-000001/ }).waitFor();

  // Printed as a debit note against the invoice.
  const dn = (await call(`${B}/sales/documents?kind=INVOICE`)).body.items.find((d) => d.number === 'DN-000001');
  await page.goto(`${O}/print/${dn.id}`);
  const frame = page.frameLocator('iframe').first();
  await frame.getByRole('heading', { name: 'Debit note' }).waitFor();
  await frame.getByText(/INV-000001 of/).waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
