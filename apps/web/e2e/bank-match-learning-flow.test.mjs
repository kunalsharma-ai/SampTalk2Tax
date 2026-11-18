/**
 * Browser end-to-end test for adaptive matching suggestions (BANK-017): a statement line from
 * Sharma Traders is matched by hand, and the next one is then suggested with the same account
 * ahead of a same-amount line on a closer date, with the reason shown. What matching learned
 * lists the pattern. Real Next.js app → real API → real MongoDB.
 * Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];

async function call(path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a hand match teaches the next suggestion, which says why', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Match Learning Owner');
  await page.getByLabel('Email').fill(`e2e-match-learning-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Match Learning Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;

  const accounts = (await call(`${base}/accounts`)).body;
  const list = accounts.items ?? accounts;
  const acc = (code) => list.find((a) => a.code === code);
  const bank = acc('1120').id;
  const d = (n) => new Date(Date.now() + 5.5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
  const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'YYYY-MM-DD', hasHeader: true };
  const receipt = async (date, code) => {
    const r = await call(`${base}/journals`, { date, memo: 'Receipt', post: true, lines: [{ accountId: bank, debit: '5000.00' }, { accountId: acc(code).id, credit: '5000.00' }] });
    assert.equal(r.status, 201);
  };
  const importLine = async (date, text) => assert.equal((await call(`${base}/banking/accounts/${bank}/imports`, { fileName: `${text}.csv`, csv: `Date,Description,Reference,Amount\n${date},${text},,5000.00`, mapping })).status, 201);

  // Last week's receipt from Sharma Traders, booked to other income: matched from the screen.
  await receipt(d(9), '4900');
  await importLine(d(9), 'NEFT SHARMA TRADERS UTR111');
  await page.goto(`${WEB}/orgs/${orgId}/banking/${bank}`);
  await page.getByRole('row', { name: /UTR111/ }).getByRole('button', { name: 'Match', exact: true }).click();
  await page.getByText('Everything is matched').waitFor();

  // Two same-amount receipts now: sales on the very day, other income two days later.
  await receipt(d(4), '4100');
  await receipt(d(2), '4900');
  await importLine(d(4), 'IMPS SHARMA TRADERS UTR222');
  await page.reload();
  const row = page.getByRole('row', { name: /UTR222/ });
  await row.getByText(/You matched similar lines to .+ 1 time before/).waitFor();
  await row.getByText('2 days apart').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-learned-suggestion.png`, fullPage: true });

  await page.getByRole('button', { name: 'What matching learned' }).click();
  const dialog = page.getByRole('dialog', { name: 'What matching learned' });
  const pattern = dialog.getByRole('row', { name: /sharma, traders/ });
  await pattern.waitFor();
  assert.match(await pattern.innerText(), new RegExp(acc('4900').name));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-what-matching-learned.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
