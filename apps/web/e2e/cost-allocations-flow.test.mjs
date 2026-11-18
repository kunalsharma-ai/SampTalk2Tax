/**
 * Browser end-to-end test for cost allocation (GL-024): the owner adds a rule spreading untagged
 * rent to two departments, previews the period, posts it, and sees the run with its journal.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
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

test('shared rent is allocated to departments and posted once', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Alloc Owner');
  await page.getByLabel('Email').fill(`e2e-alloc-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Allocation Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  for (const [code, name] of [['SALES', 'Sales'], ['OPS', 'Operations']]) assert.equal((await call(`${base}/dimensions`, { type: 'DEPARTMENT', code, name })).status, 201);
  assert.equal((await call(`${base}/journals`, { date: T, memo: 'Office rent', post: true, lines: [{ accountId: acc['6200'], debit: '60000.00' }, { accountId: acc['1120'], credit: '60000.00' }] })).status, 201);

  await page.getByRole('link', { name: 'Cost allocation', exact: true }).click();
  await page.getByRole('heading', { name: 'Cost allocation', exact: true }).waitFor();
  await page.getByText('No allocation rules yet').waitFor();
  await page.getByRole('button', { name: 'New rule' }).click();
  await page.getByLabel('Name').fill('Rent by floor area');
  await page.getByRole('checkbox', { name: /6200/ }).check();
  await page.getByLabel('Department 1', { exact: true }).selectOption({ label: 'SALES Sales' });
  await page.getByLabel('Share 1 (percent)').fill('60');
  await page.getByLabel('Department 2', { exact: true }).selectOption({ label: 'OPS Operations' });
  await page.getByLabel('Share 2 (percent)').fill('40');
  await page.getByText('Total 100%').waitFor();
  await page.getByRole('button', { name: 'Add rule' }).click();

  await page.getByLabel('From (Rent by floor area)').fill(`${T.slice(0, 7)}-01`);
  await page.getByLabel('To (Rent by floor area)').fill(T);
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('table', { name: 'Allocation preview for Rent by floor area' });
  await preview.getByText('₹36,000.00').waitFor();
  await preview.getByText('₹24,000.00').waitFor();
  await shot('cost-allocation-preview');
  await page.getByRole('button', { name: /Post allocation of/ }).click();
  const runs = page.getByRole('table', { name: 'Allocation runs' });
  await runs.getByText('Posted').waitFor();
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByText('Already posted for this period.').waitFor();
  await shot('cost-allocation-posted');

  await runs.getByRole('link', { name: 'Journal' }).click();
  await page.waitForURL(/\/journals\/[0-9a-f-]{36}$/);
  await page.getByText('Cost allocation: Rent by floor area', { exact: false }).first().waitFor();
  assert.deepEqual(consoleErrors, []);
});
