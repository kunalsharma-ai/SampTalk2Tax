/**
 * Browser end-to-end test for exchange rates and revaluation: a person records a USD rate, a
 * journal in USD takes it, the revaluation page shows the balance at a new rate, and posting it
 * leaves a record with its journal and reversal. Real Next.js app → real API → real PostgreSQL.
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

test('a USD bank balance is revalued at the period end and the record is kept', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('FX Owner');
  await page.getByLabel('Email').fill(`e2e-fx-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E FX Pvt Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const usd = (await call(`${base}/accounts`, { code: '1130', name: 'USD Bank', type: 'ASSET', subtype: 'BANK' })).body;

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Exchange rates', exact: true }).click();
  await page.getByRole('heading', { name: 'Exchange rates and revaluation' }).waitFor();
  const rates = page.locator('[aria-label="Exchange rates"]');
  await rates.getByLabel('Rate').fill('83');
  await rates.getByLabel('Source (optional)').fill('Bank rate');
  await rates.getByRole('button', { name: 'Save rate' }).click();
  await rates.getByRole('cell', { name: 'Bank rate' }).waitFor();

  // A journal in USD without a rate takes the recorded one.
  const je = await call(`${base}/journals`, { date: T, post: true, memo: 'USD funding', lines: [{ accountId: usd.id, currency: 'USD', debit: '10000.00' }, { accountId: acc['3100'], credit: '830000.00' }] });
  assert.equal(je.status, 201);
  assert.equal(je.body.lines[0].exchangeRate, '83');

  await page.reload();
  const reval = page.locator('[aria-label="Revaluation"]');
  await reval.getByRole('row', { name: /1130 USD Bank/ }).waitFor();
  await reval.getByLabel('USD rate').fill('84.5');
  await reval.getByRole('row', { name: /Unrealised exchange gain.*₹15,000\.00/ }).waitFor();
  await reval.getByRole('button', { name: 'Post revaluation' }).click();
  await reval.getByRole('status').getByText(/Posted FXR-0001/).waitFor();

  const past = page.locator('[aria-label="Past revaluations"]');
  await past.getByRole('row', { name: /FXR-0001.*USD 84\.5.*₹15,000\.00/ }).waitFor();
  const list = (await call(`${base}/fx/revaluations`)).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].gain, '15000.00');
  // A second one on the same date is refused before it is sent.
  assert.equal(await reval.getByRole('button', { name: 'Post revaluation' }).isDisabled(), true);

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
