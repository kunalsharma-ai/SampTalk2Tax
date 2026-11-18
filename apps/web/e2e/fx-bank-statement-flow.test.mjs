/**
 * Browser end-to-end test for a bank account kept in another currency (BANK-012): an owner
 * keeps an account in USD, imports a USD statement, records a customer receipt and a bank fee
 * from it, matches the opening deposit and reconciles in USD, while the books carry INR.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page, base, orgId, usd;
const consoleErrors = [];
const day = (n) => new Date(Date.parse(`${new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)}T00:00:00Z`) - (10 - n) * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const statement = ['Date,Details,Amount', `${dmy(day(0))},OPENING DEPOSIT,5000.00`, `${dmy(day(3))},WIRE ACME INC,1000.00`, `${dmy(day(4))},WIRE FEE,-25.00`].join('\n');

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
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

test('a USD account is imported, matched and reconciled in USD', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('USD Owner');
  await page.getByLabel('Email').fill(`e2e-usd-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E USD Exports');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  base = page.url();
  orgId = base.split('/').pop();
  const api = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${api}/accounts`)).body.map((a) => [a.code, a.id]));
  assert.equal((await call(`${api}/fx/rates`, { currency: 'USD', date: day(0), rate: '83' }, 'PUT')).status, 200);
  assert.equal((await call(`${api}/fx/rates`, { currency: 'USD', date: day(3), rate: '84' }, 'PUT')).status, 200);
  usd = (await call(`${api}/accounts`, { code: '1130', name: 'USD Account', type: 'ASSET', subtype: 'BANK' })).body.id;
  const customer = (await call(`${api}/contacts`, { name: 'Acme Inc', isCustomer: true })).body;
  assert.equal((await call(`${api}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: day(1), currency: 'USD', post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '1000' }] })).status, 201);

  // The owner keeps the account in USD before anything is imported.
  await page.goto(`${base}/banking/${usd}`);
  await page.getByRole('button', { name: 'Currency: INR' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Account currency').fill('usd');
  await d.getByRole('button', { name: 'Save currency' }).click();
  await page.getByRole('button', { name: 'Currency: USD' }).waitFor();
  const opening = await call(`${api}/journals`, { date: day(0), memo: 'Opening deposit', post: true, lines: [{ accountId: usd, currency: 'USD', debit: '5000.00' }, { accountId: acc['3100'], currency: 'USD', credit: '5000.00' }] });
  assert.equal(opening.status, 201);

  await page.getByRole('link', { name: 'Import statement' }).click();
  await page.getByText('This account is kept in USD: the amounts are read as USD.').waitFor();
  await page.getByLabel('Statement file').setInputFiles({ name: 'usd.csv', mimeType: 'text/csv', buffer: Buffer.from(statement) });
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('heading', { name: '3 new lines' }).waitFor();
  assert.match(await page.getByText(/^Money in/).textContent(), /\$6,000\.00/);
  await page.getByRole('button', { name: 'Import 3 lines' }).click();
  await page.waitForURL(/\/banking\/[0-9a-f-]{36}$/);

  // The wire settles the USD invoice; the fee is posted in USD.
  await page.getByRole('row', { name: /WIRE ACME INC/ }).getByRole('button', { name: 'Resolve…' }).click();
  await d.getByRole('tab', { name: 'Customer receipt' }).click();
  await d.getByLabel('Customer').selectOption({ label: 'Acme Inc' });
  await d.getByLabel('Apply to INV-000001').waitFor();
  await d.getByRole('button', { name: 'Record receipt' }).click();
  await d.waitFor({ state: 'detached' });
  await page.getByRole('row', { name: /WIRE FEE/ }).getByRole('button', { name: 'Resolve…' }).click();
  await d.getByRole('tab', { name: 'Other money out' }).click();
  await d.getByLabel('Account').selectOption({ label: '6900 · Bank Charges' });
  await d.getByRole('button', { name: 'Post and match' }).click();
  await d.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Match 1 suggested' }).click();
  await page.getByText('Everything is matched').waitFor();

  await page.getByRole('link', { name: 'Reconcile' }).click();
  await page.getByLabel('Opening balance').fill('0');
  await page.getByLabel('Closing balance on the statement').fill('5975');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByText('Ready to reconcile').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-usd-reconcile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Complete reconciliation' }).click();
  await page.getByText(/Reconciled to/).first().waitFor();

  // The list shows USD, and what the books carry in INR: 5,000 at 83, 1,000 at 84, less 25 at 84.
  await page.goto(`${base}/banking`);
  const row = page.getByRole('row', { name: /1130 · USD Account/ });
  await row.getByText('$5,975.00').first().waitFor();
  await row.getByText(/4,96,900\.00 in the accounts/).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-usd-account-list.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
