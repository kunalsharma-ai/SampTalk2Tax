/**
 * Browser end-to-end test for audit sampling (AUDIT-009): the owner posts journals, draws a
 * random sample from a seed, records one exception and passes the rest, and the sample completes;
 * drawing again from the same seed picks the same items.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const password = 'e2e-very-long-password';
let browser;
const consoleErrors = [];
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

test('a sample is drawn from a seed, tested item by item and completed', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Sana Samples');
  await page.getByLabel('Email').fill(`e2e-samples-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Samples Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const orgId = orgUrl.split('/').pop();
  const posted = await page.evaluate(async (id) => {
    const h = { 'content-type': 'application/json', 'x-t2t-csrf': '1' };
    const accounts = await (await fetch(`/api/t2t/v1/orgs/${id}/accounts`)).json();
    const acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const day = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const out = [];
    for (const amount of ['1200.00', '450.00', '8000.00', '2300.00', '640.00', '15000.00']) {
      const r = await fetch(`/api/t2t/v1/orgs/${id}/journals`, { method: 'POST', headers: h, body: JSON.stringify({ date: day, post: true, memo: `Office spend ${amount}`, lines: [{ accountId: acc['6200'], debit: amount }, { accountId: acc['1120'], credit: amount }] }) });
      out.push(r.status);
    }
    return out;
  }, orgId);
  assert.deepEqual(posted, [201, 201, 201, 201, 201, 201]);

  await page.goto(`${orgUrl}/audit-samples`);
  await page.getByText('No samples yet').waitFor();
  await page.getByLabel('Sample name').fill('Office spend check');
  await page.getByLabel('Items to pick').fill('3');
  await page.getByLabel('Seed').fill('e2e-seed-7');
  await page.getByRole('button', { name: 'Draw sample' }).click();
  await page.getByRole('heading', { name: 'S-001: Office spend check' }).waitFor();
  await page.getByLabel('Redraw check').getByText(/picks the same 3 items/).waitFor();
  const items = page.getByLabel('Sampled items');
  const rows = items.locator('tbody tr');
  assert.equal(await rows.count(), 3);
  const firstPick = await rows.locator('a').allTextContents();
  await shot(page, 'audit-sample-drawn');

  // One exception, with what was found; the rest pass.
  const first = rows.nth(0);
  await first.getByRole('textbox').fill('No receipt attached to this journal');
  await first.getByRole('button', { name: 'Exception', exact: true }).click();
  await items.getByText('No receipt attached to this journal').waitFor();
  for (let k = 0; k < 2; k++) {
    await items.getByRole('button', { name: 'No exception' }).first().click();
    await page.waitForFunction((n) => document.querySelectorAll('[aria-label="Sampled items"] button').length === n, (1 - k) * 2);
  }
  await page.getByText(/^Completed on /).waitFor();
  await shot(page, 'audit-sample-completed');

  // Drawing again with the same seed picks the same items.
  await page.goto(`${orgUrl}/audit-samples`);
  await page.getByLabel('Audit samples').getByText('Completed').waitFor();
  await page.getByLabel('Sample name').fill('Same seed again');
  await page.getByLabel('Items to pick').fill('3');
  await page.getByLabel('Seed').fill('e2e-seed-7');
  await page.getByRole('button', { name: 'Draw sample' }).click();
  await page.getByRole('heading', { name: 'S-002: Same seed again' }).waitFor();
  assert.deepEqual(await page.getByLabel('Sampled items').locator('tbody tr a').allTextContents(), firstPick);
  assert.deepEqual(consoleErrors, []);
});
