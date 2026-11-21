/**
 * Browser end-to-end test for opening balances (GL-010): the owner enters balances account by
 * account, sees the difference that will go to Opening Balance Equity, posts them, and finds them
 * in the trial balance; then corrects a figure and replaces them, leaving one set in the books.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function call(path) {
  return page.evaluate(async (u) => {
    const r = await fetch(`/api/t2t${u}`, { headers: { 'x-t2t-csrf': '1' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, path);
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of 422/.test(m.text()) && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('opening balances are posted, show in the trial balance, and can be replaced', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Opal Owner');
  await page.getByLabel('Email').fill(`e2e-ob-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Opening Balances Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();

  await page.getByRole('link', { name: 'Opening balances' }).first().click();
  await page.waitForURL(/\/opening-balances$/);
  await page.getByRole('heading', { name: 'Opening balances' }).waitFor();
  await page.getByText('Receivables and payables').waitFor();
  // Control accounts are not offered.
  assert.equal(await page.getByLabel('1200 Accounts Receivable debit').count(), 0);

  await page.getByLabel('1120 Operating Bank Account debit').fill('250000');
  await page.getByLabel('1510 Property, Plant and Equipment debit').fill('800000');
  await page.getByLabel('3100 Share Capital credit').fill('1000000');
  // The difference shows before posting, against the account it will go to.
  const diffRow = page.getByRole('row', { name: /To 3250 Opening Balance Equity/ });
  await diffRow.getByText('₹50,000.00').waitFor();
  // Typing a credit clears the debit on the same account.
  await page.getByLabel('1110 Cash on Hand debit').fill('10');
  await page.getByLabel('1110 Cash on Hand credit').fill('10');
  assert.equal(await page.getByLabel('1110 Cash on Hand debit').inputValue(), '');
  await page.getByText('1110 Cash on Hand usually has a debit balance').waitFor();
  await page.getByLabel('1110 Cash on Hand credit').fill('');
  await shot('opening-balances-entry');

  await page.getByRole('button', { name: 'Post opening balances' }).click();
  await page.getByText('Opening balances posted').waitFor();
  await page.getByText(/^Posted as JE-\d+ on /).waitFor();
  await page.getByRole('button', { name: 'Replace opening balances' }).waitFor();
  await shot('opening-balances-posted');

  const tb = async () => (await call(`/v1/orgs/${orgId}/reports/trial-balance?asOf=${T}`)).body;
  let t = await tb();
  assert.equal(t.balanced, true);
  assert.deepEqual(['1120', '1510', '3100', '3250'].map((c) => { const r = t.rows.find((x) => x.code === c); return [c, r.netDebit, r.netCredit]; }), [
    ['1120', '250000.00', '0.00'],
    ['1510', '800000.00', '0.00'],
    ['3100', '0.00', '1000000.00'],
    ['3250', '0.00', '50000.00'],
  ]);

  // The missing ₹50,000 was a loan: add it and replace the balances.
  await page.reload();
  assert.equal(await page.getByLabel('1120 Operating Bank Account debit').inputValue(), '250000.00');
  await page.getByLabel('2700 Long-Term Loans credit').fill('50000');
  await page.getByRole('row', { name: /To 3250 Opening Balance Equity/ }).getByText('₹').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Replace opening balances' }).click();
  await page.getByText('Opening balances posted').waitFor();
  t = await tb();
  assert.equal(t.rows.find((x) => x.code === '2700').netCredit, '50000.00');
  const obe = t.rows.find((x) => x.code === '3250');
  assert.ok(!obe || (obe.netDebit === '0.00' && obe.netCredit === '0.00'));
  const opening = (await call(`/v1/orgs/${orgId}/journals?type=OPENING`)).body;
  assert.equal(opening.total, 2);
  assert.deepEqual(consoleErrors, []);
});
