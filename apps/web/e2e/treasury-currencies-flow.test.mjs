/**
 * Browser end-to-end test for TRS-002 cash by currency: an owner with a rupee bank account and a
 * dollar bank account opens Treasury and sees the dollar account in dollars and rupees, and cash
 * totalled by currency with each one's share. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(`${T}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
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

test('treasury shows cash held in each currency', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Treasury Owner');
  await page.getByLabel('Email').fill(`e2e-treasury-fx-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Treasury Currencies Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const api = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(`${api}/accounts`)).body.map((a) => [a.code, a.id]));
  assert.equal((await call(`${api}/fx/rates`, { currency: 'USD', date: day(5), rate: '83.50' }, 'PUT')).status, 200);
  const usd = (await call(`${api}/accounts`, { code: '1130', name: 'USD Account', type: 'ASSET', subtype: 'BANK' })).body.id;
  assert.equal((await call(`${api}/banking/accounts/${usd}/currency`, { currency: 'USD' }, 'PUT')).status, 200);
  assert.equal((await call(`${api}/journals`, { date: day(2), memo: 'Capital', post: true, lines: [{ accountId: acc['1120'], debit: '250000.00' }, { accountId: acc['3100'], credit: '250000.00' }] })).status, 201);
  assert.equal((await call(`${api}/journals`, { date: day(2), memo: 'Dollar capital', post: true, lines: [{ accountId: usd, currency: 'USD', debit: '3000.00' }, { accountId: acc['3100'], currency: 'USD', credit: '3000.00' }] })).status, 201);

  await page.goto(`${base}/treasury`);
  const balances = page.getByRole('table', { name: 'Cash and bank balances' });
  const usdRow = balances.getByRole('row').filter({ hasText: 'USD Account' });
  await usdRow.getByText('$3,000.00').waitFor();
  await usdRow.getByText('₹2,50,500.00').waitFor();
  const byCurrency = page.getByRole('table', { name: 'Cash by currency' });
  const usdTotal = byCurrency.getByRole('row').filter({ hasText: /^USD/ });
  await usdTotal.getByText('50.0%').waitFor();
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/treasury-cash-by-currency.png` });
  }
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
