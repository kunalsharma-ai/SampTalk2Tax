/**
 * Browser end-to-end test for budgets: an owner creates a draft budget, fills it by
 * spreading annual amounts and typing a month, saves it and submits it; an approver (a
 * second signed-in user) sends it back with a reason, the owner submits again and the
 * approver approves it; budget vs actual compares it with journals posted this month,
 * including an account nobody budgeted; and a new version starts from the approved one.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const t = new Date();
const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
let browser, owner, approver, orgId, base, budgetId, accounts;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function call(p, path, body, method = body ? 'POST' : 'GET') {
  return p.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

async function register(page, name, email) {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
}

const journal = (debit, credit, amount) =>
  call(owner, `/v1/orgs/${orgId}/journals`, { date: today, post: true, memo: 'E2E budget actuals', lines: [{ accountId: accounts[debit], debit: amount }, { accountId: accounts[credit], credit: amount }] });

before(async () => {
  browser = await chromium.launch();
  owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  approver = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, approver]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the owner drafts a budget by spreading annual amounts and typing a month', async () => {
  await register(owner, 'Budget Owner', `e2e-budget-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Planning Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = owner.url().split('/').pop();
  base = `${WEB}/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(owner, `/v1/orgs/${orgId}/accounts`)).body.map((a) => [a.code, a.id]));
  for (const [d, c, a] of [['1120', '4100', '52000.00'], ['6200', '1120', '20000.00'], ['6300', '1120', '1500.00']]) assert.equal((await journal(d, c, a)).status, 201);

  await owner.getByRole('link', { name: 'Budgets', exact: true }).click();
  await owner.getByText(/No budget for FY\d{4} yet/).waitFor();
  await owner.getByRole('button', { name: 'New version' }).first().click();
  const dlg = owner.getByRole('dialog');
  await dlg.getByLabel('Start from').selectOption('EMPTY');
  await dlg.getByLabel('Name').fill('E2E plan');
  await dlg.getByRole('button', { name: 'Create draft' }).click();
  await owner.waitForURL(/\/planning\/budgets\/[0-9a-f-]{36}$/);
  budgetId = owner.url().split('/').pop();
  await owner.getByRole('heading', { name: /v1 E2E plan/ }).waitFor();

  await owner.getByRole('button', { name: 'Spread an annual amount for 4100' }).click();
  await owner.getByRole('dialog').getByLabel(/Annual amount/).fill('600000');
  await owner.getByRole('dialog').getByText('50000.00 a month').waitFor();
  await owner.getByRole('dialog').getByRole('button', { name: 'Spread' }).click();
  await owner.getByRole('button', { name: 'Spread an annual amount for 6200' }).click();
  await owner.getByRole('dialog').getByLabel(/Annual amount/).fill('100');
  await owner.getByRole('dialog').getByRole('button', { name: 'Spread' }).click();
  // 100 / 12: the first four months get the extra paisa
  assert.equal(await owner.getByLabel(/^6200 /).first().inputValue(), '8.34');
  assert.equal(await owner.getByLabel(/^6200 /).last().inputValue(), '8.33');
  await owner.getByRole('button', { name: 'Clear 6200' }).click();
  const rentCells = owner.getByLabel(/^6200 /);
  for (let i = 0; i < 12; i++) await rentCells.nth(i).fill('25000');
  await rentCells.nth(11).fill('25000.555');
  await owner.getByText('Month 12: at most 2 decimal places').waitFor();
  assert.equal(await owner.getByRole('button', { name: 'Save changes' }).isDisabled(), true);
  await rentCells.nth(11).fill('25000');
  await owner.getByText('2 accounts changed').waitFor();
  await owner.getByRole('button', { name: 'Save changes' }).click();
  await owner.getByText('No unsaved changes').waitFor();
  await owner.getByText(/Year: revenue ₹6,00,000\.00, expenses ₹3,00,000\.00, net income ₹3,00,000\.00/).waitFor();
  await shot(owner, 'b1-draft');
  // Saved, not just on screen
  const saved = (await call(owner, `/v1/orgs/${orgId}/budgets/${budgetId}`)).body;
  assert.deepEqual(saved.totals.year, { revenue: '600000.00', expenses: '300000.00', netIncome: '300000.00' });
});

test('the owner submits; an approver sends it back, then approves it', async () => {
  await owner.getByRole('button', { name: 'Submit for approval' }).click();
  await owner.getByText('You submitted this version, so someone else must approve it.').waitFor();
  assert.equal(await owner.getByRole('button', { name: 'Approve' }).count(), 0);
  assert.equal(await owner.getByLabel(/^4100 /).count(), 0, 'no inputs once submitted');

  const email = `e2e-budget-approver-${randomUUID()}@example.test`;
  await register(approver, 'Budget Approver', email);
  assert.equal((await call(owner, `/v1/orgs/${orgId}/members`, { email, role: 'APPROVER' })).status, 201);
  await approver.goto(`${base}/planning/budgets/${budgetId}`);
  await approver.getByRole('button', { name: 'Send back' }).click();
  await approver.getByRole('dialog').getByLabel('Reason').fill('Rent rises in October');
  await approver.getByRole('dialog').getByRole('button', { name: 'Send back' }).click();
  await approver.getByText(/Sent back by Budget Approver/).waitFor();

  await owner.reload();
  await owner.getByText(/“Rent rises in October”/).waitFor();
  await owner.getByRole('button', { name: 'Submit for approval' }).click();
  await owner.getByText('Waiting for approval', { exact: true }).waitFor();

  await approver.reload();
  await approver.getByRole('button', { name: 'Approve' }).click();
  await approver.getByText(/Approved by Budget Approver/).waitFor();
  await shot(approver, 'b2-approved');
});

test('budget vs actual compares the approved budget with this month’s journals', async () => {
  await owner.getByRole('link', { name: 'Budget vs actual', exact: true }).first().click();
  await owner.getByText('Revenue, year to date').waitFor();
  await owner.getByRole('button', { name: 'Months' }).click();
  await owner.waitForURL(/by=MONTH/);
  const sales = owner.getByRole('row', { name: '4100 Sales Revenue' });
  await sales.getByText('₹52,000.00').first().waitFor();
  assert.match(await sales.textContent(), /of ₹50,000\.00\+₹2,000\.00 \(4\.0%\)/);
  const utilities = owner.getByRole('row', { name: '6300 Utilities' });
  await utilities.getByText('Not budgeted').waitFor();
  const v = (await call(owner, `/v1/orgs/${orgId}/budgets/${budgetId}/variance?granularity=YEAR`)).body;
  assert.equal(v.netIncome.buckets[0].actual, '30500.00');
  assert.equal(v.netIncome.fullYearBudget, '300000.00');
  await shot(owner, 'b3-budget-vs-actual');
});

test('a new version starts from the approved one, which stays fixed', async () => {
  await owner.goto(`${base}/planning/budgets/${budgetId}`);
  await owner.getByText('This is the approved budget for the year.', { exact: false }).waitFor();
  await owner.getByRole('button', { name: 'New version from this' }).click();
  await owner.waitForURL((u) => !u.pathname.endsWith(budgetId));
  await owner.getByRole('heading', { name: /v2 E2E plan \(revised\)/ }).waitFor();
  assert.equal(await owner.getByLabel(/^4100 /).first().inputValue(), '50000.00');
  await owner.getByRole('link', { name: '← All versions' }).click();
  await owner.getByRole('cell', { name: /v1 · E2E plan/ }).waitFor();
  await owner.getByText('Version 1 is the approved budget.').waitFor();
  assert.deepEqual(consoleErrors, []);
});
