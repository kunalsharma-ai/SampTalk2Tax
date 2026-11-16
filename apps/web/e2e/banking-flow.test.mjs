/**
 * Browser end-to-end test for banking: import a CSV statement, resolve each line
 * (customer receipt, bank entry, exclusion) and reconcile. Real Next.js app → real
 * API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, base, orgId;
const consoleErrors = [];

const todayIso = new Date().toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(`${todayIso}T00:00:00Z`) - (10 - n) * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const statement = [
  'Txn Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt',
  `${dmy(day(1))},NEFT HARBOUR CAFE,UTR778812,,"11,800.00"`,
  `${dmy(day(2))},BANK CHARGES OCT,,500.00,`,
  `${dmy(day(3))},DUPLICATE ENTRY FROM BANK,,999.00,`,
].join('\n');

/** Setup calls go through the same proxy the app uses. */
async function call(path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json() };
    },
    [path, body],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => browser?.close());

test('a new organisation has an opening bank balance and an open invoice', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Bank Owner');
  await page.getByLabel('Email').fill(`e2e-bank-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Bank Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  base = page.url();
  orgId = base.split('/').pop();
  const acc = Object.fromEntries((await call(`/v1/orgs/${orgId}/accounts`)).body.map((a) => [a.code, a.id]));
  const ob = await call(`/v1/orgs/${orgId}/journals`, { date: day(0), memo: 'Opening balance', post: true, lines: [{ accountId: acc['1120'], debit: '100000.00' }, { accountId: acc['3100'], credit: '100000.00' }] });
  assert.equal(ob.status, 201);
  const customer = await call(`/v1/orgs/${orgId}/contacts`, { name: 'Harbour Cafe', isCustomer: true });
  const inv = await call(`/v1/orgs/${orgId}/sales/documents`, { kind: 'INVOICE', contactId: customer.body.id, issueDate: day(0), post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '11800.00' }] });
  assert.equal(inv.status, 201);
});

test('a CSV statement is previewed with detected columns, then imported', async () => {
  await page.goto(`${base}/banking`);
  await page.getByRole('link', { name: '1120 · Operating Bank Account' }).click();
  await page.getByText('No statement lines yet').waitFor();
  await page.getByRole('link', { name: 'Import a statement' }).click();
  await page.getByLabel('Statement file (CSV)').setInputFiles({ name: 'hdfc-oct.csv', mimeType: 'text/csv', buffer: Buffer.from(statement) });
  // Columns are guessed from the bank's header names.
  assert.equal(await page.getByLabel('Amounts are in').inputValue(), 'split');
  assert.equal(await page.getByLabel('Description column').locator('option:checked').textContent(), 'Narration');
  assert.equal(await page.getByLabel('Money out column').locator('option:checked').textContent(), 'Withdrawal Amt');
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('heading', { name: '3 new lines' }).waitFor();
  await page.getByRole('button', { name: 'Import 3 lines' }).click();
  await page.waitForURL(/\/banking\/[0-9a-f-]{36}$/);
  await page.getByRole('cell', { name: 'NEFT HARBOUR CAFE Ref UTR778812' }).waitFor();
  assert.equal(await page.getByRole('row').count(), 4);
});

test('importing the same file again adds nothing', async () => {
  await page.getByRole('link', { name: 'Import statement' }).click();
  await page.getByLabel('Statement file (CSV)').setInputFiles({ name: 'hdfc-oct.csv', mimeType: 'text/csv', buffer: Buffer.from(statement) });
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('heading', { name: '0 new lines' }).waitFor();
  assert.equal(await page.getByText('Already imported', { exact: true }).count(), 3);
  assert.ok(await page.getByRole('button', { name: 'Import 0 lines' }).isDisabled());
  await page.goto(page.url().replace(/\/import$/, ''));
  await page.getByRole('row', { name: /NEFT HARBOUR CAFE/ }).waitFor();
});

test('money in is recorded as a customer receipt that settles the invoice', async () => {
  await page.getByRole('row', { name: /NEFT HARBOUR CAFE/ }).getByRole('button', { name: 'Resolve…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Customer receipt' }).click();
  await dialog.getByLabel('Customer').selectOption({ label: 'Harbour Cafe' });
  await dialog.getByLabel('Apply to INV-000001').waitFor();
  assert.equal(await dialog.getByLabel('Apply to INV-000001').inputValue(), '11800.00');
  await dialog.getByRole('button', { name: 'Record receipt' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('row', { name: /NEFT HARBOUR CAFE/ }).waitFor({ state: 'detached' });
});

test('bank charges are posted to an expense account and matched', async () => {
  await page.getByRole('row', { name: /BANK CHARGES OCT/ }).getByRole('button', { name: 'Resolve…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Other money out' }).click();
  // Receivables and payables are not offered here.
  const options = await dialog.getByLabel('Account').locator('option').allTextContents();
  assert.ok(!options.some((o) => o.startsWith('1200') || o.startsWith('2100') || o.startsWith('1120')));
  await dialog.getByLabel('Account').selectOption({ label: '6900 · Bank Charges' });
  await dialog.getByRole('button', { name: 'Post and match' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Matched' }).click();
  await page.getByText('Booked from bank').waitFor();
  await page.getByText('Recorded from bank').waitFor();
  await page.getByRole('link', { name: 'RCPT-000001' }).waitFor();
});

test('a duplicate line is excluded with a reason', async () => {
  await page.getByRole('tab', { name: /To review/ }).click();
  await page.getByRole('row', { name: /DUPLICATE ENTRY/ }).getByRole('button', { name: 'Resolve…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Exclude' }).click();
  await dialog.getByLabel('Reason').fill('The bank listed this card payment twice');
  await dialog.getByRole('button', { name: 'Exclude line' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByText('Everything is matched').waitFor();
});

test('the account reconciles to the statement and its lines lock', async () => {
  await page.getByRole('link', { name: 'Reconcile' }).click();
  await page.getByLabel('Opening balance').fill('100000');
  await page.getByLabel('Closing balance on the statement').fill('110000');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByText('Not reconciled yet').waitFor();
  await page.getByText(/differs from the statement by 1300.00/).waitFor();
  await page.getByLabel('Closing balance on the statement').fill('111300');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByText('Ready to reconcile').waitFor();
  await page.getByRole('button', { name: 'Complete reconciliation' }).click();
  await page.getByText(/Reconciled to/).first().waitFor();
  await page.getByRole('cell', { name: 'Reconciled' }).waitFor();
  await page.getByRole('link', { name: 'Back to statement lines' }).click();
  await page.getByRole('tab', { name: 'All' }).click();
  await page.getByRole('row', { name: /DUPLICATE ENTRY/ }).waitFor();
  assert.equal(await page.getByText('Reconciled', { exact: true }).count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Unmatch' }).count(), 0);
});

test('no unexpected console errors were logged', () => {
  assert.deepEqual(consoleErrors.filter((e) => !/favicon/.test(e)), [], consoleErrors.join('\n'));
});
