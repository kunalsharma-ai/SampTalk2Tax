/**
 * Browser end-to-end test for the finance director, department manager and external auditor
 * dashboards (DASH-046/059/057): an owner with an approved plan, spending charged to two
 * departments, a department budget, an audit with an auditor link and a request for evidence
 * reads each dashboard, switches the department manager to another department, then opens the
 * evidence request. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.T2T_API_URL ?? 'http://localhost:4000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, {
        method: m,
        headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const ok = (r, what) => {
  assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const twelve = (x) => Array.from({ length: 12 }, () => x);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
  });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner reads the finance director, department manager and external auditor dashboards', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Director');
  await page.getByLabel('Email').fill(`e2e-director-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Director Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const meId = ok(await call('/v1/auth/me'), 'me').user.id;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const dep = {};
  for (const [code, name] of [
    ['D01', 'Sales'],
    ['D02', 'Field service'],
  ])
    dep[name] = ok(await call(`${base}/dimensions`, { type: 'DEPARTMENT', code, name }), name).id;
  const journal = (lines) =>
    call(`${base}/journals`, {
      date: T,
      post: true,
      memo: 'Dashboard test',
      lines,
    });
  ok(
    await journal([
      { accountId: acc['6100'], debit: '12000.00', departmentId: dep.Sales },
      { accountId: acc['1120'], credit: '12000.00' },
    ]),
    'rent',
  );
  ok(
    await journal([
      {
        accountId: acc['6200'],
        debit: '4000.00',
        departmentId: dep['Field service'],
      },
      { accountId: acc['1120'], credit: '4000.00' },
    ]),
    'field',
  );
  ok(
    await journal([
      { accountId: acc['1120'], debit: '50000.00' },
      { accountId: acc['4100'], credit: '50000.00' },
    ]),
    'sales',
  );
  const fiscalYear = ok(await call(`${base}/department-budgets`), 'department budgets').fiscalYear;
  ok(await call(`${base}/department-budgets`, { departmentId: dep.Sales, fiscalYear, amount: '120000.00' }, 'PUT'), 'budget');
  // The plan: the owner prepares it; approval needs someone else, so a member approves.
  const plan = ok(
    await call(`${base}/budgets`, {
      basis: 'EMPTY',
      fiscalYear,
      name: 'Annual plan',
    }),
    'plan',
  ).budget.id;
  ok(
    await call(
      `${base}/budgets/${plan}/lines`,
      {
        lines: [
          { accountId: acc['4100'], amounts: twelve('10000') },
          { accountId: acc['6100'], amounts: twelve('500') },
        ],
      },
      'PUT',
    ),
    'plan lines',
  );
  ok(await call(`${base}/budgets/${plan}/submit`, {}), 'submit plan');
  // A second member reviews the audit.
  const email = `e2e-reviewer-${randomUUID()}@example.test`;
  const reg = await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Audit Reviewer', password: 'e2e-very-long-password' }) });
  assert.equal(reg.status, 201);
  const reviewerId = (await reg.json()).user.id;
  ok(await call(`${base}/members`, { email, role: 'APPROVER' }), 'reviewer');
  // The reviewer signs in and approves the plan (approval needs someone other than who prepared it).
  const other = await browser.newPage();
  await other.goto(`${WEB}/login`);
  await other.getByLabel('Email').fill(email);
  await other.getByLabel('Password').fill('e2e-very-long-password');
  await other.getByRole('button', { name: 'Sign in' }).click();
  await other.waitForURL(/\/orgs\//);
  const approved = await other.evaluate(async ([o, id]) => (await fetch(`/api/t2t/v1/orgs/${o}/budgets/${id}/approve`, { method: 'POST', headers: { 'x-t2t-csrf': '1' } })).status, [orgId, plan]);
  assert.equal(approved, 200);
  await other.close();
  const e = ok(
    await call(`${base}/audit-engagements`, {
      name: 'Statutory audit',
      objective: 'Year-end audit',
      scopeFrom: T,
      scopeTo: T,
      leadId: meId,
      reviewerId,
    }),
    'engagement',
  );
  ok(
    await call(`${base}/audit-engagements/${e.id}/auditor-links`, {
      auditorName: 'R. Mehta',
      firm: 'Mehta and Co',
      expiresInDays: 30,
    }),
    'link',
  );
  const ask = ok(
    await call(`${base}/audit-evidence`, {
      engagementId: e.id,
      title: 'Bank confirmations',
      details: '',
      ownerId: meId,
      dueDate: T,
    }),
    'evidence',
  );
  consoleErrors = [];
  const shot = async (name) =>
    SHOTS &&
    (await page.screenshot({
      path: `${SHOTS}/role-dashboards-${name}.png`,
      fullPage: true,
    }));

  // Finance director: the plan against actual, the accounts off it, departments and closes.
  await page.goto(`${WEB}/orgs/${orgId}/reports/role-dashboards?role=FINANCE_DIRECTOR`);
  const tabs = page.getByRole('tablist', { name: 'Dashboard for' });
  const quarters = page.getByRole('table', { name: 'Plan by quarter' });
  await quarters.getByRole('row', { name: /Year to date/ }).waitFor();
  assert.equal(await quarters.getByRole('row').count(), 6);
  await page.getByRole('table', { name: 'Accounts off plan' }).getByRole('row', { name: /6100 · Salaries and Wages/ }).waitFor();
  await page.getByRole('img', { name: /Planned and actual net income by quarter/ }).waitFor();
  await page.getByRole('table', { name: 'Months and their close' }).waitFor();
  await page
    .getByRole('region', { name: 'Departments to watch' })
    .getByText(/1 on track and 1 without a budget|0 on track/)
    .waitFor();
  await shot('finance-director');

  // Department manager: Sales by default, then Field service.
  await tabs.getByRole('tab', { name: 'Department manager', exact: true }).click();
  await page.waitForURL(/role=DEPARTMENT_MANAGER/);
  const accounts = page.getByRole('table', { name: 'Spending by account' });
  await accounts.getByRole('row', { name: /6100.*100\.0%/ }).waitFor();
  await page.getByRole('group', { name: 'Spent this year' }).getByText('₹12,000.00').waitFor();
  await shot('department-manager');
  await page.getByRole('combobox', { name: 'Department to show' }).selectOption(dep['Field service']);
  await page.waitForURL(new RegExp(`department=${dep['Field service']}`));
  await accounts.getByRole('row', { name: /6200.*100\.0%/ }).waitFor();
  await page.getByRole('group', { name: 'Budget status' }).getByText('No budget').waitFor();

  // External auditor: the year, the link and the evidence request.
  await tabs.getByRole('tab', { name: 'External auditor', exact: true }).click();
  await page.waitForURL(/role=EXTERNAL_AUDITOR/);
  await page.getByRole('list', { name: 'Links for auditors' }).getByText('R. Mehta, Mehta and Co').waitFor();
  await page.getByRole('table', { name: 'Fiscal years' }).getByRole('row').nth(1).waitFor();
  await shot('external-auditor');
  await page
    .getByRole('list', { name: 'Evidence not yet accepted' })
    .getByRole('link', { name: /Bank confirmations/ })
    .click();
  await page.waitForURL(new RegExp(`/audit-evidence/${ask.id}$`));
  assert.deepEqual(consoleErrors, []);
});
