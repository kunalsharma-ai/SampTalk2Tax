/**
 * Browser end-to-end test for international payments (AP-023): a vendor's bank abroad is added and
 * verified on the vendor's page (a wrong IBAN is refused), a remittance against their USD bills is
 * prepared with a purpose code, the detail page asks for the Form 15CA Part C and 15CB numbers above
 * ₹5 lakh, they are entered, the sole approver approves it, the bank instruction is downloaded
 * (which marks it sent) and the payment is recorded at the bank's rate, settling the bills.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a remittance abroad is prepared, its Form 15CA numbers entered, approved, sent and paid', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Remittance Owner');
  await page.getByLabel('Email').fill(`e2e-intl-pay-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Outward Remittance Labs');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));

  // Two posted USD bills worth USD 7,000 at 83 (₹5.81 lakh, above the ₹5 lakh line).
  assert.equal((await call(`${B}/fx/rates`, { currency: 'USD', date: T, rate: '83' }, 'PUT')).status, 200);
  const vendor = (await call(`${B}/contacts`, { name: 'Northstar Analytics LLC', isVendor: true, address: '200 Park Ave, New York' })).body;
  const bills = [];
  for (const [amount, ref] of [['4000', 'NS-501'], ['3000', 'NS-502']]) {
    const d = (await call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: T, dueDate: addDays(T, 30), currency: 'USD', reference: ref, lines: [{ accountId: acc['6600'], description: 'Data analytics retainer', quantity: '1', unitPrice: amount }] })).body;
    bills.push((await call(`${B}/purchases/documents/${d.id}/post`, {})).body);
  }

  // The vendor's bank abroad: a bad IBAN is refused, a US account with its ABA number is kept and verified.
  await page.goto(`${O}/purchases/vendors/${vendor.id}`);
  await page.getByRole('button', { name: 'Add bank details' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Where is the bank?').selectOption('INTERNATIONAL');
  await dlg.getByLabel('Account holder name').fill('Northstar Analytics LLC');
  await dlg.getByLabel('IBAN or account number').fill('DE88370400440532013000');
  await dlg.getByLabel('SWIFT/BIC').fill('COBADEFF');
  await dlg.getByLabel('Bank country (2 letters)').fill('DE');
  await dlg.getByRole('button', { name: 'Save bank details' }).click();
  await dlg.getByText(/check digits are wrong/).waitFor();
  await dlg.getByLabel('IBAN or account number').fill('000123456789');
  await dlg.getByLabel('SWIFT/BIC').fill('CHASUS33');
  await dlg.getByLabel('Bank country (2 letters)').fill('US');
  await dlg.getByLabel(/^Routing code/).fill('021000021');
  await dlg.getByLabel('Bank name (optional)').fill('JPMorgan Chase');
  await dlg.getByRole('button', { name: 'Save bank details' }).click();
  await page.getByText('CHASUS33 · US · 021000021').waitFor();
  await page.getByRole('button', { name: 'Verify…' }).click();
  await page.getByRole('dialog').getByLabel('How were they confirmed?').fill('Called Northstar finance on the number in the contract');
  await page.getByRole('dialog').getByRole('button', { name: 'Mark verified' }).click();
  await page.getByText('Verified', { exact: true }).first().waitFor();

  // Prepare the remittance on Purchases → International payments.
  await page.goto(`${O}/purchases/international-payments`);
  const prep = page.locator('[aria-label="Prepare an international payment"]');
  await prep.getByLabel('Vendor and currency').selectOption({ label: 'Northstar Analytics LLC · USD' });
  for (const b of bills) await prep.getByLabel(`Pay ${b.number}`).check();
  await prep.getByLabel('Purpose (RBI purpose code)').selectOption('S0802');
  await prep.getByRole('button', { name: 'Prepare payment' }).click();
  await page.waitForURL(/\/international-payments\/[0-9a-f-]{36}$/);
  const pid = page.url().split('/').pop();
  await page.getByRole('heading', { name: 'International payment IP-0001' }).waitFor();
  await page.getByText('Form 15CA Part C, after Form 15CB').waitFor();
  await page.getByText('Enter the acknowledgement number of Form 15CA Part C').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve' }).isDisabled(), true);

  // Enter the Form 15CA and 15CB numbers, then approve.
  await page.getByLabel('Form 15CA acknowledgement number').fill('271234567890123');
  await page.getByLabel('Form 15CB certificate number (UDIN)').fill('26123456ABCDEF7890');
  await page.getByLabel('Charges').selectOption('SHA');
  await page.getByRole('button', { name: 'Save details' }).click();
  await page.getByText('Form 15CA acknowledgement: 271234567890123').waitFor();
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByText('Self-approved').waitFor();

  // The bank instruction marks it sent.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download bank instruction' }).click()]);
  const csv = await readFile(await download.path(), 'utf8');
  assert.match(csv, /Amount,7000\.00/);
  assert.match(csv, /Beneficiary bank SWIFT\/BIC,CHASUS33/);
  assert.match(csv, /Purpose code,S0802/);
  assert.match(csv, /Charges,SHA/);
  await page.getByText('Sent to bank', { exact: true }).first().waitFor();

  // Recorded at the bank's rate of 84: ₹5,88,000 and both bills settled.
  await page.getByRole('button', { name: 'Record as paid' }).click();
  const pay = page.getByRole('dialog');
  await pay.getByLabel(/Bank's rate/).fill('84');
  await pay.getByLabel('Bank reference (optional)').fill('OWR/26/77120');
  await pay.getByRole('button', { name: 'Record payment' }).click();
  await page.getByText('Paid', { exact: true }).first().waitFor();
  await page.getByText(/bank ref OWR\/26\/77120/).waitFor();
  assert.match(await page.locator('main').innerText(), /5,88,000\.00/);
  const r = (await call(`${B}/purchases/international-payments/${pid}`)).body;
  assert.equal(r.status, 'PAID');
  assert.ok(r.payment?.id);
  for (const b of bills) {
    const d = (await call(`${B}/purchases/documents/${b.id}`)).body;
    assert.match(String(d.amountDue ?? d.outstanding ?? d.due), /^0(\.0+)?$/);
  }

  // The list shows it paid.
  await page.goto(`${O}/purchases/international-payments`);
  const row = page.getByRole('row', { name: /IP-0001/ });
  await row.getByText('Paid').waitFor();
  assert.match(await row.innerText(), /S0802/);
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
