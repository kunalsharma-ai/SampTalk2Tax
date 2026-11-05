/**
 * Browser end-to-end test for local financial statements: an Indian organisation posts a few
 * journals and reads its Schedule III balance sheet and statement of profit and loss, opens the
 * accounts behind a line, sees an unclassified account flagged, and switches to the IAS 1 layout.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

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

test('an Indian company reads its Schedule III statements and the accounts behind them', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Statutory Owner');
  await page.getByLabel('Email').fill(`e2e-statutory-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Statutory Pvt Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const post = async (debit, credit, amount) => assert.equal((await call(`${base}/journals`, { date: T, post: true, memo: 'E2E', lines: [{ accountId: acc[debit], debit: amount }, { accountId: acc[credit], credit: amount }] })).status, 201);
  await post('1120', '3100', '500000.00');
  await post('1510', '1120', '120000.00');
  await post('6800', '1520', '10000.00');
  await post('1120', '4100', '300000.00');
  const odd = (await call(`${base}/accounts`, { code: '1990', name: 'Suspense advances', type: 'ASSET' })).body;
  assert.equal((await call(`${base}/journals`, { date: T, post: true, memo: 'E2E', lines: [{ accountId: odd.id, debit: '5000.00' }, { accountId: acc['1120'], credit: '5000.00' }] })).status, 201);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Statutory statements', exact: true }).click();
  await page.getByRole('heading', { name: 'Statutory statements' }).waitFor();
  const bs = page.locator('[aria-label="Balance sheet"]');
  const pl = page.locator('[aria-label="Statement of profit and loss"]');
  await bs.getByRole('row', { name: /Total assets.*₹7,90,000\.00/ }).waitFor();
  await bs.getByRole('row', { name: /Total equity and liabilities.*₹7,90,000\.00/ }).waitFor();
  await pl.getByRole('row', { name: /VII\. Profit \(loss\) for the period.*₹2,90,000\.00/ }).waitFor();
  await page.getByText('Balances', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Layout').inputValue(), 'IN_SCHEDULE_III');
  await page.getByText('Agrees with profit and loss', { exact: true }).waitFor();

  // The accounts behind property, plant and equipment.
  await bs.getByRole('button', { name: /\(a\) Property, plant and equipment/ }).click();
  await bs.getByRole('link', { name: /1520 Accumulated Depreciation/ }).waitFor();
  assert.match(await bs.getByRole('row', { name: /1520 Accumulated Depreciation/ }).innerText(), /-₹10,000\.00|−₹10,000\.00|\(₹10,000\.00\)/);

  // The account with no subtype is flagged.
  await page.getByText('1 account has no subtype').waitFor();
  await page.getByText(/1990 Suspense advances/).waitFor();

  // Another layout.
  await page.getByLabel('Layout').selectOption('IFRS_IAS1');
  await page.locator('[aria-label="Statement of financial position"]').getByRole('row', { name: /Total equity and liabilities.*₹7,90,000\.00/ }).waitFor();
  await page.getByText('Not your country’s layout').waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
