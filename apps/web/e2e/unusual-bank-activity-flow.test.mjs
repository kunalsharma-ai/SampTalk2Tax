/**
 * Browser end-to-end test for unusual bank activity (BANK-019, BANK-023): an owner imports a
 * statement with a duplicate payment, cash deposits split just under 50,000 and money paid straight
 * back out; Unusual bank activity lists them most serious first with what each sign was raised
 * on, the period can be narrowed, and a line opens its account to reconcile.
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

test('unusual statement lines are listed with their warning signs', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Vikram Vigilant');
  await page.getByLabel('Email').fill(`e2e-bankwatch-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Bank Watch Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const bank = (accounts.accounts ?? accounts).find((a) => a.code === '1120').id;
  const csv = [
    'Date,Narration,Ref,Amount',
    `${dmy(addDays(T, -12))},IMPS TEAK SUPPLIES REF 1,IMPS1,-25000.00`,
    `${dmy(addDays(T, -11))},IMPS TEAK SUPPLIES REF 2,IMPS2,-25000.00`,
    `${dmy(addDays(T, -6))},CASH DEPOSIT,,48000.00`,
    `${dmy(addDays(T, -5))},CASH DEPOSIT BRANCH 2,,49500.00`,
    `${dmy(addDays(T, -4))},CASH DEPOSIT,,47000.00`,
    `${dmy(addDays(T, -2))},RTGS CR UNKNOWN PARTY,UTR9,300000.00`,
    `${dmy(addDays(T, -1))},RTGS DR ONWARD TRANSFER,UTR10,-295000.00`,
  ].join('\n');
  await must(call(`${B}/banking/accounts/${bank}/imports`, { fileName: 'nov.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }));

  await page.goto(`${base}/banking/unusual-activity`);
  const table = page.getByRole('table', { name: 'Unusual bank activity' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  const text = await rows.allInnerTexts();
  assert.equal(text.length, 7);
  assert.match(text[0], /High[\s\S]*RTGS DR ONWARD TRANSFER[\s\S]*Straight in and out[\s\S]*Paid out 1 day after ₹3,00,000\.00 came in/);
  assert.ok(text.some((t) => /CASH DEPOSIT BRANCH 2[\s\S]*Just under the threshold[\s\S]*One of 3 credits within 7 days each just under ₹50,000\.00/.test(t)));
  assert.equal(text.filter((t) => /Possible duplicate/.test(t)).length, 2);
  await page.getByText('Lines with warning signs', { exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/unusual-bank-activity.png`, fullPage: true });

  await page.getByLabel('Period').selectOption('7');
  await page.waitForFunction(() => document.querySelectorAll('table[aria-label="Unusual bank activity"] tbody tr').length === 5);
  assert.equal((await rows.allInnerTexts()).some((t) => /Possible duplicate/.test(t)), false);
  await rows.first().getByRole('link', { name: 'Operating Bank Account' }).click();
  await page.waitForURL(new RegExp(`/banking/${bank}/reconcile`));
  assert.deepEqual(consoleErrors, []);
});
