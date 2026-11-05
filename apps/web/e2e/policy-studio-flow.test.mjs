/**
 * Browser end-to-end test for the policy studio: an accountant writes a policy in words with a
 * rule and tests, runs the tests and a back-test on real bills, and saves it; the owner approves
 * it, which turns the rule into a running automation, and later retires it.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, owner, accountant;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const call = (page, path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const ok = (r, what) => {
  assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

async function register(page, name, email) {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
}
async function newPage() {
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  p.on('dialog', (d) => d.accept());
  return p;
}

before(async () => {
  browser = await chromium.launch();
  owner = await newPage();
  accountant = await newPage();
});
after(async () => browser?.close());

test('an accountant writes and tests a policy, the owner approves it into an automation and retires it', async () => {
  const accEmail = `e2e-policy-acc-${randomUUID()}@example.test`;
  await register(accountant, 'Anu Accountant', accEmail);
  await register(owner, 'Omar Owner', `e2e-policy-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Policy Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  ok(await call(owner, `${base}/members`, { email: accEmail, role: 'ACCOUNTANT' }), 'member');
  const fy = +T.slice(0, 4) + (+T.slice(5, 7) >= 4 ? 1 : 0);
  const years = new Set(ok(await call(owner, `${base}/periods`), 'periods').map((p) => p.fiscalYear));
  if (!years.has(fy)) ok(await call(owner, `${base}/periods/fiscal-years`, { fiscalYear: fy }), 'fiscal year');
  const acc = Object.fromEntries(ok(await call(owner, `${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const vendor = ok(await call(owner, `${base}/contacts`, { name: 'Granite Parts', isVendor: true }), 'vendor').id;
  for (const [ref, amount] of [['GP-1', '650000.00'], ['GP-2', '120000.00']]) ok(await call(owner, `${base}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: T, reference: ref, post: true, lines: [{ accountId: acc['5000'], quantity: '1', unitPrice: amount }] }), 'bill');

  // The accountant writes the policy.
  const a = accountant;
  await a.goto(`${WEB}/orgs/${orgId}/governance/policies`);
  await a.getByText('No policies yet').waitFor();
  await a.getByRole('link', { name: 'New policy' }).click();
  await a.getByLabel('Policy name').fill('Spending control');
  await a.getByLabel('Policy', { exact: true }).fill('Bills over ₹5 lakh need an approver’s review within two days.');
  await a.getByRole('region', { name: 'Draft with AI' }).waitFor();
  await a.getByLabel('Rule 1 name').fill('Review large bills');
  await a.getByLabel('Condition 1 test').selectOption({ label: 'is more than' });
  await a.getByLabel('Condition 1 value').fill('500000');
  await a.getByLabel('Task title').fill('Review bill {{number}} from {{contactName}}');
  await a.getByRole('button', { name: 'Add a test' }).click();
  await a.getByLabel('Test 1 label').fill('A ₹6 lakh bill needs review');
  await a.getByLabel('Test 1 total').fill('600000.00');
  await a.getByRole('button', { name: 'Add a test' }).click();
  await a.getByLabel('Test 2 label').fill('Exactly ₹5 lakh does not');
  await a.getByLabel('Test 2 total').fill('500000.00');
  await a.getByLabel('Test 2 expected').selectOption('ACTS');
  await a.getByRole('button', { name: 'Run the tests' }).click();
  await a.getByText('1 of 2 tests fail.').waitFor();
  await a.getByText('Total is more than 500000 (is 500000.00)').waitFor();
  // The test was wrong: exactly ₹5 lakh should not act.
  await a.getByLabel('Test 2 expected').selectOption('DOES_NOT_ACT');
  await a.getByRole('button', { name: 'Run the tests' }).click();
  await a.getByText('All 2 tests pass.').waitFor();
  await a.getByText('A bill is posted, and total is more than INR 500000.00: give Approvers a task').first().waitFor();
  await a.getByRole('button', { name: 'Back-test on the last 90 days' }).click();
  await a.getByTestId('backtest').getByText(/Would have acted on\s*1\s*of 2 events/).waitFor();
  await a.getByRole('button', { name: 'Save policy' }).click();
  await a.waitForURL(/\/governance\/policies\/[0-9a-f-]{36}$/);
  const policyUrl = a.url();
  await a.getByRole('heading', { name: 'POL-0001 · Spending control' }).waitFor();
  await a.getByText('Waiting for approval').first().waitFor();
  await a.getByText('Created on approval').waitFor();

  // The owner approves it, which turns the rule into a running automation.
  const o = owner;
  await o.goto(policyUrl);
  await o.getByRole('button', { name: 'Approve and turn on' }).waitFor();
  await o.getByLabel('Approval note (optional)').fill('Agreed at the finance meeting');
  await o.getByRole('button', { name: 'Approve and turn on' }).click();
  await o.getByText('Approved and running').first().waitFor();
  await o.getByRole('link', { name: 'POL-0001 · Review large bills' }).waitFor();
  const history = o.getByRole('table', { name: 'History' });
  await history.getByText('Agreed at the finance meeting').waitFor();
  const wf = ok(await call(o, `${base}/workflows`), 'workflows');
  const list = Array.isArray(wf) ? wf : wf.items;
  assert.equal(list.find((w) => w.name === 'POL-0001 · Review large bills')?.enabled, true);

  // The policy links to the automation that runs its rule.
  await o.getByRole('link', { name: 'POL-0001 · Review large bills' }).click();
  await o.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await o.goto(policyUrl);

  // Retiring turns the automation off.
  await o.getByRole('button', { name: 'Retire policy' }).click();
  await o.getByText('Retired', { exact: true }).first().waitFor();
  const after = ok(await call(o, `${base}/workflows`), 'workflows');
  assert.equal((Array.isArray(after) ? after : after.items).find((w) => w.name === 'POL-0001 · Review large bills')?.enabled, false);

  await a.goto(`${WEB}/orgs/${orgId}/governance/policies`);
  await a.getByRole('table', { name: 'Policies' }).getByText('Retired').waitFor();
  assert.deepEqual(consoleErrors, []);
});
