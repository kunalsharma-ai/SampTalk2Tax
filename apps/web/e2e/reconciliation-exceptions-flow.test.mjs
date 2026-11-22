/**
 * Browser end-to-end test for reconciliation exceptions (BANK-020): an owner imports a statement
 * and has entries in the books that do not match; Reconciliation exceptions explains each one (a
 * fee taken off, two cheques banked together, a returned payment, bank charges, money not in the
 * books, a stale cheque, one in transit) with what to do, shows them by kind and age, and an
 * exception opens its account to reconcile.
 * Real Next.js app → real API → real MongoDB.
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
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const d = (n) => addDays(T, -n);
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('unmatched items are explained with what to do about each', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Rekha Reconciler');
  await page.getByLabel('Email').fill(`e2e-recon-exc-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Recon Exceptions Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = Object.fromEntries((accounts.accounts ?? accounts).map((a) => [a.code, a.id]));
  const bank = acc['1120'];
  const csv = [
    'Date,Narration,Ref,Amount',
    `${dmy(d(40))},NEFT CR WALK IN CUSTOMER,UTR1,5000.00`,
    `${dmy(d(20))},NEFT CR HARBOUR CAFE,UTR2,9950.00`,
    `${dmy(d(15))},CHQ DEP 100201,,3000.00`,
    `${dmy(d(15))},CHQ DEP 100202,,2000.00`,
    `${dmy(d(12))},RTGS DR TEAK SUPPLIES,UTR3,-7000.00`,
    `${dmy(d(11))},RTGS RETURN TEAK SUPPLIES,UTR4,7000.00`,
    `${dmy(d(5))},SMS CHARGES QTR,,-59.00`,
  ].join('\n');
  await must(call(`${B}/banking/accounts/${bank}/imports`, { fileName: 'recon.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }));
  const journal = (lines, date, memo) => must(call(`${B}/journals`, { date, memo, post: true, lines }));
  await journal([{ accountId: bank, debit: '10000.00' }, { accountId: acc['4900'], credit: '10000.00' }], d(21), 'Receipt Harbour Cafe');
  await journal([{ accountId: bank, debit: '5000.00' }, { accountId: acc['4900'], credit: '5000.00' }], d(16), 'Two cheques banked');
  await journal([{ accountId: acc['6200'], debit: '4000.00' }, { accountId: bank, credit: '4000.00' }], d(39), 'Cheque 000777 to landlord');
  await journal([{ accountId: bank, debit: '800.00' }, { accountId: acc['4900'], credit: '800.00' }], d(1), 'Cash deposit');
  consoleErrors.length = 0;

  await page.goto(`${base}/banking/reconciliation-exceptions`);
  const table = page.getByRole('table', { name: 'Reconciliation exceptions' });
  await table.waitFor();
  const text = await table.locator('tbody tr').allInnerTexts();
  assert.equal(text.length, 7);
  assert.match(text[0], /Amounts differ[\s\S]*The bank shows 9950\.00 and the books 10000\.00: 50\.00 less at the bank[\s\S]*Receipt Harbour Cafe[\s\S]*book the difference/);
  assert.match(text[1], /Split or combined[\s\S]*2 statement lines add up to one entry of 5000\.00/);
  assert.match(text[2], /Reversed[\s\S]*7000\.00 in and out again on the statement/);
  assert.match(text[3], /Bank charges or interest[\s\S]*SMS CHARGES QTR[\s\S]*Create an entry to bank charges/);
  assert.match(text[4], /Not in the books[\s\S]*NEFT CR WALK IN CUSTOMER/);
  assert.match(text[5], /Old, not on any statement[\s\S]*34 days older than the latest statement line/);
  assert.match(text[6], /In transit[\s\S]*Dated after the latest statement line/);
  await page.getByText('Need action', { exact: true }).waitFor();
  await page.getByLabel('Bank account').selectOption(bank);
  const kinds = await page.getByRole('table', { name: 'Exception kinds' }).locator('tbody tr').allInnerTexts();
  assert.equal(kinds.length, 7);
  const ages = await page.getByRole('table', { name: 'Unmatched items by age' }).locator('tbody tr').allInnerTexts();
  assert.match(ages[2], /31 to 90 days[\s\S]*1[\s\S]*1/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/reconciliation-exceptions.png`, fullPage: true });

  await table.locator('tbody tr').first().getByRole('link', { name: 'Operating Bank Account' }).click();
  await page.waitForURL(new RegExp(`/banking/${bank}/reconcile`));
  assert.deepEqual(consoleErrors, []);
});
