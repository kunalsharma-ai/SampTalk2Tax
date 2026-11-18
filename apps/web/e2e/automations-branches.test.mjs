/**
 * Browser end-to-end test for either/or branches in automations (WFLOW-005): an owner builds a
 * workflow that acts when any of two conditions holds and does something else otherwise, tests
 * it, turns it on, and the running API takes each branch on the invoices that follow. Real
 * Next.js app → real API → real MongoDB → the API's own runner (WORKFLOW_RUNNER_INTERVAL_SECONDS
 * small, as in CI).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page, orgId, base, accounts;
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
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a workflow acts when any condition holds and does the otherwise actions when none does', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Branch Owner');
  await page.getByLabel('Email').fill(`e2e-branches-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Branches Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const contact = async (name) => (await call(`${base}/contacts`, { name, isCustomer: true })).body;
  const banyan = await contact('Banyan Retail');
  const shop = await contact('Small Shop');
  const invoice = async (who, amount) => (await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: who.id, issueDate: T, post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: amount }] })).body;
  await invoice(shop, '700.00');

  await page.goto(`${WEB}/orgs/${orgId}/automations/new`);
  await page.getByRole('heading', { name: 'New workflow' }).waitFor();
  await page.getByLabel('Workflow name').fill('Large or key invoices');
  await page.getByLabel('Trigger').selectOption({ label: 'An invoice is posted' });
  // No otherwise branch until there is a condition to be "otherwise" to.
  assert.equal(await page.locator('[aria-label="Otherwise"]').count(), 0);
  await page.getByRole('button', { name: 'Add a condition' }).click();
  const c1 = page.getByRole('group', { name: 'Condition 1' });
  await c1.getByLabel('Condition 1 fact').selectOption({ label: 'Total' });
  await c1.getByLabel('Condition 1 test').selectOption({ label: 'is at least' });
  await c1.getByLabel('Condition 1 value').fill('100000');
  assert.equal(await page.getByLabel('Acts when').count(), 0);
  await page.getByRole('button', { name: 'Add a condition' }).click();
  const c2 = page.getByRole('group', { name: 'Condition 2' });
  await c2.getByLabel('Condition 2 fact').selectOption({ label: 'Customer' });
  await c2.getByLabel('Condition 2 test').selectOption({ label: 'contains' });
  await c2.getByLabel('Condition 2 value').fill('banyan');
  await page.getByLabel('Acts when').selectOption({ label: 'Any one of the conditions holds' });
  const main = page.getByRole('group', { name: 'Action 1' });
  await main.getByLabel('Task title').fill('Review {{number}} closely');
  await main.getByLabel('For').selectOption({ label: 'Branch Owner' });
  const otherwise = page.locator('[aria-label="Otherwise"]');
  await otherwise.getByRole('button', { name: 'Add task instead' }).click();
  const alt = page.getByRole('group', { name: 'Otherwise action 1' });
  await alt.getByLabel('Task title').fill('Spot-check {{vendorName}}');
  await alt.getByLabel('For').selectOption({ label: 'Branch Owner' });
  await page.getByRole('button', { name: 'Create workflow' }).click();
  // The otherwise actions are checked like the others.
  await page.getByText('Otherwise action 1: {{vendorName}} is not available for an invoice is posted').waitFor();
  await alt.getByLabel('Task title').fill('Spot-check {{number}}');
  await shot('branches-editor');
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await page.getByText('Any one of:').waitFor();
  await page.locator('[aria-label="Otherwise"]').getByText('Task “Spot-check {{number}}” for Branch Owner').waitFor();

  // A test on the small invoice already posted takes the otherwise branch.
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  const result = page.getByLabel('Test result');
  await result.getByText('Test: the conditions do not hold, so it would do the otherwise actions').waitFor();
  await result.getByText('Actions (otherwise)').waitFor();
  await result.getByText(/“Spot-check INV-\d+” for Branch Owner/).waitFor();
  await result.getByRole('button', { name: 'Close' }).click();

  // Turned on, each later invoice takes its branch.
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.getByRole('button', { name: 'Turn off' }).waitFor();
  const key = await invoice(banyan, '5000.00');
  const small = await invoice(shop, '800.00');
  const runs = page.getByRole('table', { name: 'Runs' });
  for (let i = 0; i < 30; i++) {
    await page.reload();
    await page.getByRole('heading', { name: 'Large or key invoices' }).waitFor();
    if ((await runs.getByRole('row').count()) >= 4) break; // header + two runs + the test
    await page.waitForTimeout(1000);
  }
  const keyRow = runs.getByRole('row').filter({ has: page.getByRole('link', { name: `Invoice ${key.number}` }) });
  const smallRow = runs.getByRole('row').filter({ has: page.getByRole('link', { name: `Invoice ${small.number}` }) });
  await keyRow.getByText('Task: done').waitFor();
  assert.equal(await keyRow.getByText('Otherwise:').count(), 0);
  await smallRow.getByText('Otherwise: Task: done').waitFor();
  await shot('branches-runs');
  const titles = (await call(`${base}/tasks?scope=all&status=ALL`)).body.tasks.map((t) => t.title).sort();
  assert.deepEqual(titles, [`Review ${key.number} closely`, `Spot-check ${small.number}`].sort());
  await page.goto(`${WEB}/orgs/${orgId}/automations`);
  await page.getByText('any of 2 conditions').waitFor();
  await page.getByText('otherwise 1 task').waitFor();
  // Only the refused first save.
  assert.deepEqual(consoleErrors, ['Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)']);
});
