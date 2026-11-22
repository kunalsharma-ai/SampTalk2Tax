/**
 * Browser end-to-end test for cash movement forecasting (BANK-022): an owner imports a statement
 * with monthly rent going out and a weekly settlement coming in, and has an opening balance in the
 * books; Bank cash forecast shows the repeating movements, the balance week by week from the books
 * and the lowest point, and a shorter horizon.
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
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const addMonths = (iso, k) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = y * 12 + (m - 1) + k;
  const ny = Math.floor(t / 12);
  const nm = t % 12;
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, lastDay(ny, nm))).padStart(2, '0')}`;
};
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
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the bank balance is forecast week by week from what repeats on the statements', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Chetan Cashflow');
  await page.getByLabel('Email').fill(`e2e-cash-moves-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Bank Forecast Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = Object.fromEntries((accounts.accounts ?? accounts).map((a) => [a.code, a.id]));
  const bank = acc['1120'];
  const csv = [
    'Date,Narration,Ref,Amount',
    ...[1, 2, 3, 4, 5, 6].map((k) => `${dmy(addMonths(T, -k))},RENT SHREE ESTATES,,-50000.00`),
    ...Array.from({ length: 10 }, (_, k) => `${dmy(addDays(T, -7 * (k + 1)))},UPI CR SWIGGY SETTLEMENT ${k},,${k % 2 ? '13000.00' : '12000.00'}`),
    `${dmy(addDays(T, -20))},NEFT CR CUSTOMER A,UTR1,26000.00`,
    `${dmy(addDays(T, -11))},POS DR AMAZON,,-1300.00`,
  ].join('\n');
  await must(call(`${B}/banking/accounts/${bank}/imports`, { fileName: 'year.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }));
  await must(call(`${B}/journals`, { date: T, memo: 'Opening balance', post: true, lines: [{ accountId: bank, debit: '300000.00' }, { accountId: acc['3100'], credit: '300000.00' }] }));

  await page.goto(`${base}/banking/cash-movements`);
  const weeks = page.getByRole('table', { name: 'Weekly bank balance forecast' });
  await weeks.waitFor();
  assert.equal(await weeks.locator('tbody tr').count(), 13);
  await page.getByText('₹3,00,000.00', { exact: true }).first().waitFor();
  const repeating = await page.getByRole('table', { name: 'Repeating bank movements' }).locator('tbody tr').allInnerTexts();
  assert.equal(repeating.length, 2);
  assert.match(repeating[0], /RENT SHREE ESTATES[\s\S]*Money out, always the same[\s\S]*Monthly[\s\S]*-₹50,000\.00[\s\S]*6/);
  assert.match(repeating[1], /UPI CR SWIGGY SETTLEMENT 0[\s\S]*Money in, varies by up to 4%[\s\S]*Weekly[\s\S]*₹12,500\.00[\s\S]*10[\s\S]*\(due, not seen yet\)/);
  await page.getByText('Lowest expected', { exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bank-cash-forecast.png`, fullPage: true });

  await page.getByLabel('Weeks ahead').selectOption('30');
  await page.waitForFunction(() => document.querySelectorAll('table[aria-label="Weekly bank balance forecast"] tbody tr').length === 5);
  assert.deepEqual(consoleErrors, []);
});
