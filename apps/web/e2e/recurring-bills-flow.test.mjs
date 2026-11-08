/**
 * Browser end-to-end test for recurring bills (AP-005): a GST-registered owner opens a posted rent
 * bill and chooses Make recurring; the form is filled from the bill (vendor, lines, GST rate,
 * SAC); a vendor reference without a placeholder is refused before saving; saved as RB-0001 it
 * shows its upcoming bills; Make due bills now makes today's bill as a draft with the reference
 * filled; the draft opens in Bills; pausing shows in the list; and the API refuses the same
 * reference again.
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
const OWN = gstin('29', 'ZZZCD0401Z');
const LANDLORD = gstin('29', 'ZZZCD0402Z');
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

test('a bill made recurring becomes a schedule that makes its bills', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Recurring Bill Owner');
  await page.getByLabel('Email').fill(`e2e-recurring-bills-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Recurring Bills Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  assert.equal((await call(`${B}/gst/registration`, { gstin: OWN, legalName: 'E2E Recurring Bills Traders Private Limited', effectiveFrom: `${FY}-04-01` }, 'PUT')).status, 200);
  const g18 = (await call(`${B}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' })).body;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const landlord = (await call(`${B}/contacts`, { name: 'Indiranagar Estates', isVendor: true, gstin: LANDLORD })).body;
  const bill = (await call(`${B}/purchases/documents`, { kind: 'BILL', contactId: landlord.id, issueDate: T, reference: 'IE/LEASE/OLD', memo: 'Office lease', post: true, lines: [{ accountId: acc['6200'], description: 'Office lease', quantity: '1', unitPrice: '60000', taxRateId: g18.id, hsnCode: '997212' }] })).body;
  assert.equal(bill.status, 'POSTED');

  // Make recurring from the bill: the form is filled from it.
  await page.goto(`${O}/purchases/bills/${bill.id}`);
  await page.getByRole('link', { name: 'Make recurring…' }).click();
  await page.waitForURL(/recurring-bills\/new\?fromBill=/);
  await page.getByText(`Filled from ${bill.number}`).waitFor();
  await page.getByText('Intra-state: CGST + SGST').waitFor();
  assert.equal(await page.getByLabel('Account for line 1').inputValue(), acc['6200']);
  assert.equal(await page.getByLabel('HSN or SAC for line 1').inputValue(), '997212');
  assert.equal(await page.getByLabel('Tax for line 1').inputValue(), g18.id);
  await page.getByRole('row', { name: /Each bill/ }).getByText(/70,800\.00/).waitFor();

  await page.getByLabel('Name').fill('Office lease, Indiranagar');
  // A reference that would repeat is refused before saving.
  await page.getByLabel("Vendor's invoice number").fill('IE/LEASE');
  await page.getByText(/would repeat on every bill/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save recurring bill' }).isDisabled(), true);
  await page.getByLabel("Vendor's invoice number").fill('IE/LEASE/{period}');
  await page.getByText(`invoice IE/LEASE/${T.slice(0, 7)}`).waitFor();
  await page.getByLabel('Memo').fill('Office lease for {month}');
  await page.getByLabel('Due after (days)').fill('7');
  await page.getByLabel('First bill date').fill(T);
  await page.getByText(/Bills dated today or earlier are made at the next hourly check/).waitFor();
  await page.getByRole('button', { name: 'Save recurring bill' }).click();

  await page.getByRole('heading', { name: 'RB-0001 · Office lease, Indiranagar' }).waitFor();
  await page.getByRole('table', { name: 'Upcoming bills' }).getByText(`IE/LEASE/${T.slice(0, 7)}`).waitFor();
  await page.getByText('No bill has been made yet.').waitFor();

  // Make the bill that is due now: a draft with the reference filled.
  await page.getByRole('button', { name: 'Make due bills now' }).click();
  await page.getByText('1 bill made').waitFor();
  const made = page.getByRole('table', { name: 'Bills made' });
  await made.getByText(`IE/LEASE/${T.slice(0, 7)}`).waitFor();
  await made.getByText('Draft', { exact: true }).waitFor();
  await made.getByRole('link', { name: 'Draft bill' }).click();
  await page.waitForURL(/purchases\/bills\/[0-9a-f-]{36}$/);
  await page.getByText(`IE/LEASE/${T.slice(0, 7)}`).first().waitFor();
  await page.getByText(/70,800\.00/).first().waitFor();

  // Pause it; the list shows it under Paused.
  await page.goto(`${O}/purchases/recurring-bills`);
  await page.getByRole('row', { name: /RB-0001.*Indiranagar Estates.*Monthly/ }).waitFor();
  await page.getByRole('link', { name: 'RB-0001' }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByText('Paused', { exact: true }).waitFor();
  await page.goto(`${O}/purchases/recurring-bills`);
  await page.getByLabel('Show').selectOption('paused');
  await page.getByRole('row', { name: /RB-0001.*Paused/ }).waitFor();

  // The run's reference cannot be entered again for the vendor.
  const dup = await call(`${B}/purchases/recurring-bills`, { name: 'Again', contactId: landlord.id, reference: 'IE/LEASE/{period}', frequency: 'MONTHLY', startDate: T, lines: [{ accountId: acc['6200'], quantity: '1', unitPrice: '1', taxRateId: g18.id, hsnCode: '997212' }] });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'DUPLICATE_BILL');

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
