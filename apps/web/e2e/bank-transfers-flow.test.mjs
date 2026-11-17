/**
 * Browser end-to-end test for transfers between own bank accounts (BANK-007): statements of two
 * accounts are imported, the bank accounts page suggests the transfer, and recording it matches
 * both lines with one entry. Real Next.js app → real API → real MongoDB.
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

test('a transfer between two own accounts is suggested and recorded', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Transfer Owner');
  await page.getByLabel('Email').fill(`e2e-transfer-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Transfers Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;

  const accounts = (await call(`${base}/accounts`)).body;
  const hdfc = (accounts.items ?? accounts).find((a) => a.code === '1120').id;
  const icici = (await call(`${base}/accounts`, { code: '1130', name: 'ICICI Savings', type: 'ASSET', subtype: 'BANK' })).body.id;
  const d = (n) => new Date(Date.now() + 5.5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
  const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'YYYY-MM-DD', hasHeader: true };
  const load = (a, rows) => call(`${base}/banking/accounts/${a}/imports`, { fileName: 'synthetic.csv', csv: ['Date,Description,Reference,Amount', ...rows].join('\n'), mapping });
  assert.equal((await load(hdfc, [`${d(3)},NEFT to ICICI own account,TRF001,-75000.00`])).status, 201);
  assert.equal((await load(icici, [`${d(2)},NEFT from HDFC,TRF001,75000.00`])).status, 201);

  await page.goto(`${WEB}/orgs/${orgId}/banking`);
  const card = page.getByRole('region', { name: 'Transfers between your accounts' });
  await card.getByText('1130 · ICICI Savings').waitFor();
  await card.getByText('Names the other account', { exact: false }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-transfer-suggested.png`, fullPage: true });
  await card.getByRole('button', { name: /Record transfer of 75000.00/ }).click();
  await card.getByText('No likely transfers among the unmatched statement lines.').waitFor();
  await page.getByRole('row', { name: /1130 · ICICI Savings/ }).getByText('All matched').waitFor();
  await page.getByRole('row', { name: /1120 · Operating Bank Account/ }).getByText('All matched').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-transfer-recorded.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
