/**
 * Browser end-to-end test for the project finance and organisation admin dashboards
 * (DASH-058/043): an owner with two projects, revenue and cost posted to each and some posted to
 * no project, an open invitation and no two-step sign-in, reads the project margins, switches to
 * the organisation admin dashboard and follows its first to-do to Members.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
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

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner reads the project finance and organisation admin dashboards', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Priya Projects');
  await page.getByLabel('Email').fill(`e2e-projects-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Project Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const project = {};
  for (const [code, name] of [
    ['P01', 'Website build'],
    ['P02', 'Data migration'],
  ])
    project[name] = ok(await call(`${base}/dimensions`, { type: 'PROJECT', code, name, customer: 'Asha Traders' }), name).id;
  const journal = (lines, what) => call(`${base}/journals`, { date: T, post: true, memo: 'Project test', lines }).then((r) => ok(r, what));
  await journal(
    [
      { accountId: acc['1120'], debit: '50000.00' },
      { accountId: acc['4100'], credit: '50000.00', projectId: project['Website build'] },
    ],
    'web sale',
  );
  await journal(
    [
      { accountId: acc['6100'], debit: '30000.00', projectId: project['Website build'] },
      { accountId: acc['1120'], credit: '30000.00' },
    ],
    'web cost',
  );
  await journal(
    [
      { accountId: acc['1120'], debit: '10000.00' },
      { accountId: acc['4100'], credit: '10000.00', projectId: project['Data migration'] },
    ],
    'migration sale',
  );
  await journal(
    [
      { accountId: acc['6200'], debit: '12000.00', projectId: project['Data migration'] },
      { accountId: acc['1120'], credit: '12000.00' },
    ],
    'migration cost',
  );
  await journal(
    [
      { accountId: acc['1120'], debit: '20000.00' },
      { accountId: acc['4100'], credit: '20000.00' },
    ],
    'other sale',
  );
  ok(await call(`${base}/invitations`, { email: `e2e-invitee-${randomUUID()}@example.test`, role: 'ACCOUNTANT' }), 'invitation');
  consoleErrors = [];
  const shot = async (name) => SHOTS && (await page.screenshot({ path: `${SHOTS}/role-dashboards-${name}.png`, fullPage: true }));

  // Project finance: losses first, the chart, and what no project carries.
  await page.goto(`${WEB}/orgs/${orgId}/reports/role-dashboards?role=PROJECT_FINANCE`);
  const projects = page.getByRole('table', { name: 'Projects' });
  await projects.getByRole('row', { name: /P02 · Data migration/ }).waitFor();
  const rows = projects.getByRole('row');
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(1).innerText(), /P02 · Data migration[\s\S]*-20\.0%[\s\S]*losing money/);
  assert.match(await rows.nth(2).innerText(), /P01 · Website build[\s\S]*40\.0%[\s\S]*healthy/);
  await page.getByRole('img', { name: /Revenue and cost of each project as bars/ }).waitFor();
  await page.getByRole('group', { name: 'Projects losing money' }).getByText('1', { exact: true }).waitFor();
  await page.getByRole('group', { name: 'Revenue without a project' }).getByText('₹20,000.00 (25.0%)').waitFor();
  await shot('project-finance');

  // Organisation admin: the to-do, who has access, invitations, connections.
  await page.getByRole('tablist', { name: 'Dashboard for' }).getByRole('tab', { name: 'Organisation admin', exact: true }).click();
  await page.waitForURL(/role=ORG_ADMIN/);
  const todo = page.getByRole('list', { name: 'Admin items' });
  await todo.getByRole('link', { name: 'Owners or admins without two-step sign-in' }).waitFor();
  await page
    .getByRole('table', { name: 'Members by role' })
    .getByRole('row', { name: /Owners 1 1/ })
    .waitFor();
  await page
    .getByRole('region', { name: 'Sign-in and invitations' })
    .getByText(/1 open, 0 expired/)
    .waitFor();
  await page
    .getByRole('table', { name: 'Integrations' })
    .getByRole('row', { name: /AI assistant Not set up/ })
    .waitFor();
  await page
    .getByRole('table', { name: 'Plan use this month' })
    .getByRole('row', { name: /AI requests/ })
    .waitFor();
  await shot('org-admin');
  await todo.getByRole('link', { name: 'Owners or admins without two-step sign-in' }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/members$`));
  assert.deepEqual(consoleErrors, []);
});
