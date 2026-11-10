/**
 * Browser end-to-end test for usage-based billing (AR-012): on a contract billed in arrears a
 * graduated usage charge is added from the contract page, the contract is activated, usage is
 * recorded by hand (a repeated reference is not added twice), a CSV with a bad row is refused and
 * a good one imported, a mistaken reading is voided, and the period's estimate follows.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
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

test('usage is metered on a contract and priced for the period', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Usage Owner');
  await page.getByLabel('Email').fill(`e2e-usage-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Metered Platform');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Godavari Foods', isCustomer: true })).body;
  const c = (await call(`${B}/sales/contracts`, { contactId: customer.id, title: 'Data platform', frequency: 'MONTHLY', timing: 'ARREARS', startDate: T, endDate: null, autoRenew: false, noticeDays: 30, lines: [{ accountId: acc['4100'], description: 'Platform fee', quantity: '1', unitPrice: '5000' }] })).body;

  await page.goto(`${WEB}/orgs/${orgId}/sales/contracts/${c.id}`);
  const card = page.locator('[aria-label="Usage charges"]');
  await card.getByRole('button', { name: 'Add usage charge' }).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name on the invoice').fill('API calls');
  await dlg.getByLabel('Meter code').fill('api_calls');
  await dlg.getByLabel('Unit', { exact: true }).fill('call');
  await dlg.getByLabel('Pricing').selectOption('GRADUATED');
  await dlg.getByLabel('Included each period').fill('500');
  await dlg.getByRole('button', { name: 'Add a tier' }).click();
  await dlg.getByRole('button', { name: 'Add a tier' }).click();
  await dlg.getByLabel('Tier 1: up to').fill('1000');
  await dlg.getByLabel('Tier 1: price per unit').fill('2');
  await dlg.getByLabel('Tier 2: up to').fill('500');
  await dlg.getByLabel('Tier 2: price per unit').fill('1.5');
  await dlg.getByLabel('Tier 3: price per unit').fill('1');
  await dlg.getByRole('button', { name: 'Save usage charge' }).click();
  await dlg.getByText('Tier 2: the upper limit must be more than 1000').waitFor();
  await dlg.getByLabel('Tier 2: up to').fill('10000');
  await dlg.getByRole('button', { name: 'Save usage charge' }).click();
  await card.getByText('Graduated tiers (to 1,000 2, to 10,000 1.5, then 1) per call after 500 included').waitFor();

  // Activate, then record usage by hand: the same reference twice is recorded once.
  await page.getByRole('button', { name: 'Activate' }).click();
  const form = card.locator('[aria-label="Record usage"]');
  await form.waitFor();
  await form.getByLabel(/^Quantity/).fill('7000');
  await form.getByLabel('Reference (optional)').fill('batch-1');
  await form.getByRole('button', { name: 'Record usage' }).click();
  await card.getByRole('row', { name: /batch-1/ }).waitFor();
  await form.getByLabel(/^Quantity/).fill('7000');
  await form.getByLabel('Reference (optional)').fill('batch-1');
  await form.getByRole('button', { name: 'Record usage' }).click();
  await card.getByText('Already recorded with that reference; not added again.').waitFor();

  // A CSV with a bad row is refused before sending; a good one is imported, skipping batch-1.
  await form.getByRole('button', { name: 'Import a CSV…' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel('CSV', { exact: true }).fill(`meter,date,quantity,reference\napi_calls,${T},6000,batch-2\napi_calls,${T},abc,batch-3`);
  await dlg.getByText('Line 3: "abc" is not a quantity').waitFor();
  await dlg.getByLabel('CSV', { exact: true }).fill(`meter,date,quantity,reference\napi_calls,${T},6000,batch-2\napi_calls,${T},7000,batch-1\napi_calls,${T},250,oops`);
  await dlg.getByRole('button', { name: 'Import 3 rows' }).click();
  await dlg.getByText('Recorded 2; 1 already recorded and skipped.').waitFor();
  await dlg.getByRole('button', { name: 'Done' }).click();

  // Void the mistaken reading; 13,000 calls less 500 included = ₹18,000 so far.
  await card.getByRole('row', { name: /oops/ }).getByRole('button', { name: 'Void…' }).click();
  await page.getByRole('dialog').getByLabel('Why').fill('Test traffic from our side');
  await page.getByRole('dialog').getByRole('button', { name: 'Void usage' }).click();
  await card.getByRole('row', { name: /oops/ }).waitFor({ state: 'detached' });
  const meters = card.locator('[aria-label="Meters"]');
  await meters.getByText('13,000 call').waitFor();
  assert.match(await meters.innerText(), /18,000\.00/);
  await card.getByLabel('Which usage').selectOption('all');
  await card.getByRole('row', { name: /oops/ }).getByText('Voided').waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
