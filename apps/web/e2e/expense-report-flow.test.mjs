/**
 * Browser end-to-end test for expense reports (EXP-017): claims submitted through the API show up
 * by category, month and merchant; clicking a category filters the report, and unticking a status
 * leaves those claims out. Real Next.js app → real API → real MongoDB. Same prerequisites as
 * ledger-flow.test.mjs.
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
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);

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
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('claimed spending is reported by category, filtered and narrowed by status', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Report Owner');
  await page.getByLabel('Email').fill(`e2e-expreport-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Expense Report Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  for (const [title, lines] of [
    ['Client visit (synthetic)', [{ date: T, accountId: acc['6400'], merchant: 'Uber', amount: '400.00' }, { date: T, accountId: acc['6600'], merchant: 'Lex Partners', amount: '1000.00' }]],
    ['Conference (synthetic)', [{ date: T, accountId: acc['6400'], merchant: 'IndiGo', amount: '5250.00' }]],
  ]) {
    const c = await call(`${base}/expense-claims`, { title, lines });
    assert.equal(c.status, 201);
    assert.equal((await call(`${base}/expense-claims/${c.body.id}/submit`, {})).status, 200);
  }

  await page.getByRole('link', { name: 'Expense reports', exact: true }).click();
  await page.getByRole('heading', { name: 'Expense reports', exact: true }).waitFor();
  const byCategory = page.getByRole('table', { name: 'Spending by category' });
  await byCategory.getByRole('row').nth(1).getByText('₹5,650.00').waitFor();
  await page.getByRole('table', { name: 'Spending by merchant' }).getByText('IndiGo').waitFor();
  await page.getByText('2 claims, 3 lines').waitFor();
  await shot('expense-report');

  await byCategory.getByRole('button', { name: /6600/ }).click();
  await page.getByRole('button', { name: /Stop filtering to/ }).waitFor();
  await page.getByText('1 claims, 1 lines').waitFor();
  await page.getByRole('table', { name: 'Spending by merchant' }).getByText('Lex Partners').waitFor();
  assert.equal(await page.getByRole('table', { name: 'Spending by merchant' }).getByText('IndiGo').count(), 0);
  await page.getByRole('button', { name: /Stop filtering to/ }).click();
  await page.getByText('2 claims, 3 lines').waitFor();

  await page.getByLabel('Waiting for approval').uncheck();
  await page.getByText('No spending in this period').waitFor();
  assert.deepEqual(consoleErrors, []);
});
