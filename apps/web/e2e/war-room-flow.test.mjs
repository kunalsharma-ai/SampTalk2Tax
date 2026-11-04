/**
 * Browser end-to-end test for the scenario war room: an owner builds a scenario whose changes
 * belong to departments, reads what each change does, tries the suggested funding, saves a new
 * version, pins a note to a month and a change, restores an earlier version, and submits it.
 * An approver in a second browser rejects it with a reason, then approves the resubmission. The
 * planning board and the risk map show the result. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, owner, approver, orgId, base, accounts;
const consoleErrors = [];
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  const y = +month.slice(0, 4) + Math.floor(m / 12);
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};

const call = (page, path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );

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
  approver = await newPage();
});
after(async () => browser?.close());

test('a team works a scenario through the war room: impacts, suggestions, notes, versions and approval', async () => {
  const approverEmail = `e2e-war-approver-${randomUUID()}@example.test`;
  await register(approver, 'Asha Approver', approverEmail);
  await register(owner, 'Omar Owner', `e2e-war-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E War Room Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = owner.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  assert.equal((await call(owner, `${base}/members`, { email: approverEmail, role: 'APPROVER' })).status, 201);
  accounts = Object.fromEntries((await call(owner, `${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const now = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7);
  const last = shift(now, -1);
  const have = new Set((await call(owner, `${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const m of [last, now]) {
    const fy = +m.slice(0, 4) + (+m.slice(5, 7) >= 4 ? 1 : 0);
    if (!have.has(fy)) assert.equal((await call(owner, `${base}/periods/fiscal-years`, { fiscalYear: fy })).status, 201), have.add(fy);
  }
  const post = async (debit, credit, amount, memo) =>
    assert.equal((await call(owner, `${base}/journals`, { date: `${last}-15`, post: true, memo, lines: [{ accountId: accounts[debit], debit: amount }, { accountId: accounts[credit], credit: amount }] })).status, 201);
  await post('1120', '3100', '200000.00', 'Capital');
  await post('1120', '4100', '300000.00', 'Sales');
  await post('5000', '1120', '120000.00', 'Stock sold');
  await post('6100', '1120', '90000.00', 'Salaries');
  await post('6200', '1120', '30000.00', 'Rent');
  const ops = (await call(owner, `${base}/dimensions`, { type: 'DEPARTMENT', code: 'OPS', name: 'Operations' })).body.id;
  const sales = (await call(owner, `${base}/dimensions`, { type: 'DEPARTMENT', code: 'SALES', name: 'Sales' })).body.id;
  const created = await call(owner, `${base}/twin/scenarios`, {
    name: 'Expand the team',
    baselineMonths: 3,
    horizonMonths: 12,
    drivers: [
      { kind: 'HIRING', count: 2, monthlyCostPerHead: '50000', fromMonth: 2, departmentId: ops },
      { kind: 'REVENUE_GROWTH', percentPerMonth: '5', fromMonth: 1, departmentId: sales },
    ],
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  // The war room: what each change does, by department.
  await owner.goto(`${WEB}/orgs/${orgId}/planning/twin/${id}`);
  const approval = owner.getByLabel('Approval');
  await approval.getByText('Draft', { exact: true }).waitFor();
  const impacts = owner.getByRole('table', { name: 'What each change does' });
  await impacts.getByRole('row').filter({ hasText: '1. Hiring' }).filter({ hasText: 'OPS · Operations' }).waitFor();
  await impacts.getByRole('row').filter({ hasText: '2. Revenue growth' }).filter({ hasText: 'SALES · Sales' }).waitFor();
  await owner.getByRole('list', { name: 'Effect by department' }).getByText('OPS · Operations').waitFor();
  assert.equal(await owner.getByRole('listitem', { name: 'Change 1: Hiring' }).getByLabel('Department').inputValue(), ops);

  // Try the suggested funding, then save it as version 2.
  const fund = owner.getByRole('listitem', { name: 'Arrange funding before cash runs out' });
  await fund.getByText('keeps cash positive for the whole period').waitFor();
  await fund.getByRole('button', { name: 'Try this' }).click();
  const loan = owner.getByRole('listitem', { name: 'Change 3: New loan' });
  await loan.waitFor();
  assert.equal(await loan.getByLabel('Interest (% a year)').inputValue(), '11');
  await owner.getByRole('button', { name: 'Save changes' }).click();
  await approval.getByRole('status').filter({ hasText: 'Saved as version 2' }).waitFor();

  // A note pinned to the second projected month and the hiring change.
  const notes = owner.getByLabel('Notes', { exact: true });
  await notes.getByLabel('Add a note').fill('Can both hires really start in month 2?');
  await notes.getByLabel('About the month').selectOption('2');
  await notes.getByLabel('About the change').selectOption('1');
  await notes.getByRole('button', { name: 'Add note' }).click();
  await notes.getByText('Notes (1 open)').waitFor();
  const n = notes.getByRole('list', { name: 'Scenario notes' }).getByRole('listitem').first();
  await n.getByText('1. Hiring').waitFor();
  await n.getByText('v2').waitFor();

  // Restore version 1 (without the loan), then go back to version 2 the same way.
  const versions = owner.getByLabel('Version history');
  await versions.getByRole('button', { name: 'Restore version 1' }).click();
  await versions.getByText('Restored from version 1 by Omar Owner').waitFor();
  await owner.getByRole('listitem', { name: 'Change 3: New loan' }).waitFor({ state: 'detached' });
  await versions.getByRole('button', { name: 'Restore version 2' }).click();
  await versions.getByText('Restored from version 2 by Omar Owner').waitFor();
  await owner.getByRole('listitem', { name: 'Change 3: New loan' }).waitFor();

  // Submit: the scenario is frozen and the submitter cannot decide it.
  await approval.getByRole('button', { name: 'Submit for approval' }).click();
  await approval.getByText('Waiting for approval').waitFor();
  await approval.getByText('You submitted this scenario, so someone else must approve or reject it.').waitFor();
  assert.equal(await owner.getByRole('listitem', { name: 'Change 1: Hiring' }).getByLabel('People').isDisabled(), true);
  assert.equal(await owner.getByRole('button', { name: 'Save changes' }).count(), 0);

  // The approver rejects without a reason (refused), then with one.
  await approver.goto(`${WEB}/orgs/${orgId}/planning/twin/${id}`);
  const a2 = approver.getByLabel('Approval');
  await a2.getByText('Submitted by Omar Owner').waitFor();
  await a2.getByRole('button', { name: 'Reject' }).click();
  await a2.getByText('Say why the scenario is rejected').waitFor();
  await a2.getByLabel('Decision note').fill('Spread the hires over two quarters');
  await a2.getByRole('button', { name: 'Reject' }).click();
  await a2.getByText('Rejected', { exact: true }).waitFor();
  await a2.getByText('“Spread the hires over two quarters”').waitFor();
  // An approver can read and add notes but cannot change the scenario.
  assert.equal(await approver.getByRole('button', { name: 'Save changes' }).count(), 0);

  // The owner changes it, which returns it to draft, and submits again; the approver approves.
  await owner.reload();
  await approval.getByText('Rejected', { exact: true }).waitFor();
  await owner.getByRole('listitem', { name: 'Change 1: Hiring' }).getByLabel('From month').selectOption('4');
  await owner.getByRole('button', { name: 'Save changes' }).click();
  await approval.getByRole('status').filter({ hasText: 'Saved as version 5' }).waitFor();
  await approval.getByText('Draft', { exact: true }).waitFor();
  await approval.getByRole('button', { name: 'Submit for approval' }).click();
  await approval.getByText('Waiting for approval').waitFor();
  await approver.reload();
  await a2.getByLabel('Decision note').fill('Approved for the board pack');
  await a2.getByRole('button', { name: 'Approve' }).click();
  await a2.getByText('Approved', { exact: true }).waitFor();
  await a2.getByText('Approved by Asha Approver').waitFor();

  // The planning board and the risk map.
  await owner.goto(`${WEB}/orgs/${orgId}/planning/twin`);
  const board = owner.getByLabel('Planning board');
  await board.getByRole('region', { name: 'Approved' }).getByRole('link', { name: 'Expand the team' }).waitFor();
  await board.getByRole('region', { name: 'Approved' }).getByText('1 open note').waitFor();
  await owner.getByRole('checkbox', { name: 'Compare Expand the team' }).check();
  await owner.getByRole('button', { name: 'Compare 1 with no change' }).click();
  const map = owner.getByRole('table', { name: 'Risk map' });
  await map.waitFor();
  await owner.getByRole('table', { name: 'Scenario comparison' }).getByText('Approved').waitFor();
  assert.ok((await map.getByRole('row').count()) >= 2);
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
