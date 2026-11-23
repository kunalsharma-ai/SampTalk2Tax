/**
 * Browser end-to-end test for department performance (DASH-035): an owner with revenue and costs
 * booked to departments and a department budget opens Reports → Department performance, sees the
 * departments compared, the monthly profit table and the ranking with margins, the unassigned
 * share and the budget status, and opens a department's own profit and loss for the same months.
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
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const ok = (r, what) => {
  assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner compares departments, sees budget use and opens a department profit and loss', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Devi Departments');
  await page.getByLabel('Email').fill(`e2e-depts-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Department Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const dep = {};
  for (const [code, name] of [['SAL', 'Sales'], ['OPS', 'Operations'], ['MKT', 'Marketing']]) dep[name] = ok(await call(`${base}/dimensions`, { type: 'DEPARTMENT', code, name }), 'department').id;
  ok(await call(`${base}/journals`, { date: today(), memo: 'Sales', post: true, lines: [{ accountId: acc['1120'], debit: '300000.00' }, { accountId: acc['4100'], credit: '240000.00', departmentId: dep.Sales }, { accountId: acc['4200'], credit: '60000.00', departmentId: dep.Operations }] }), 'sales');
  ok(
    await call(`${base}/journals`, {
      date: today(),
      memo: 'Costs',
      post: true,
      lines: [
        { accountId: acc['6100'], debit: '90000.00', departmentId: dep.Sales },
        { accountId: acc['6200'], debit: '70000.00', departmentId: dep.Operations },
        { accountId: acc['6500'], debit: '30000.00', departmentId: dep.Marketing },
        { accountId: acc['6900'], debit: '10000.00' },
        { accountId: acc['1120'], credit: '200000.00' },
      ],
    }),
    'costs',
  );
  const month = today().slice(0, 7);
  const fiscalYear = ok(await call(`${base}/reports/department-performance?from=${month}&to=${month}`), 'report').fiscalYear;
  ok(await call(`${base}/department-budgets`, { departmentId: dep.Marketing, fiscalYear, amount: '32000.00' }, 'PUT'), 'budget');
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/reports/department-performance`);
  const ranking = page.getByRole('table', { name: 'Department ranking' });
  await ranking.getByTestId('dept-SAL').getByText('₹1,50,000.00').waitFor();
  await ranking.getByTestId('dept-SAL').getByText('62.5%').waitFor();
  await ranking.getByTestId('dept-OPS').getByText('-₹10,000.00').waitFor();
  await ranking.getByTestId('dept-MKT').getByText('Near the budget').waitFor();
  await ranking.getByTestId('dept-none').getByText('Not assigned').waitFor();
  await page.getByText('5% of spending carries no department.').waitFor();
  assert.deepEqual(await ranking.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid'))), ['dept-SAL', 'dept-OPS', 'dept-MKT', 'dept-none']);
  await page.getByRole('img', { name: /Revenue, spending and profit by department/ }).locator('.recharts-bar-rectangle').first().waitFor();
  await page.getByRole('table', { name: 'Profit by department and month' }).getByRole('row', { name: /Marketing/ }).getByText('-₹30,000.00').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/department-performance.png`, fullPage: true });

  // A department opens its own profit and loss for the same months.
  await ranking.getByRole('link', { name: /Sales/ }).click();
  await page.waitForURL(/\/reports\/income-statement\?/);
  assert.ok(page.url().includes(`departmentId=${dep.Sales}`));
  await page.getByText('Sales Revenue').first().waitFor();
  assert.deepEqual(consoleErrors, []);
});
