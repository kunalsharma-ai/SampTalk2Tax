/**
 * Browser end-to-end test for leave (PAY-011): leave types are added, paid leave comes out of the
 * balance, unpaid leave becomes loss of pay on the month's draft payslip, and cancelling gives it back.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
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

test('leave is recorded against balances and unpaid leave reduces the draft payslip', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Leave Owner');
  await page.getByLabel('Email').fill(`e2e-leave-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Leave Works');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;

  const t = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
  const APR = `${FY}-04`;
  assert.equal((await call(`${base}/payroll/settings`, {}, 'PUT')).status, 200);
  const structure = { effectiveFrom: `${APR}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '30000' }] };
  assert.equal((await call(`${base}/payroll/employees`, { code: 'V001', name: 'Pooja Nair', dateOfJoining: `${APR}-01`, structure })).status, 201);
  const run = (await call(`${base}/payroll/runs`, { period: APR, payDate: `${APR}-30` })).body;

  await page.goto(`${WEB}/orgs/${orgId}/payroll/leave`);
  await page.getByRole('heading', { name: 'Leave', exact: true }).waitFor();
  const addType = async (code, name, paid, days) => {
    await page.getByRole('button', { name: 'New leave type' }).click();
    const d = page.getByRole('dialog', { name: 'New leave type' });
    await d.getByLabel('Code').fill(code);
    await d.getByLabel('Name').fill(name);
    await d.getByLabel('Pay').selectOption(paid ? 'true' : 'false');
    if (paid) await d.getByLabel('Days a year').fill(days);
    await d.getByRole('button', { name: 'Add leave type' }).click();
    await page.getByRole('table', { name: 'Leave types' }).getByRole('row', { name: new RegExp(name) }).waitFor();
  };
  await addType('EL', 'Earned leave', true, '18');
  await addType('LWP', 'Leave without pay', false);

  const record = async (type, from, to, days) => {
    await page.getByLabel('Employee', { exact: true }).selectOption({ label: 'Pooja Nair (V001)' });
    await page.getByLabel('Leave type', { exact: true }).selectOption({ label: type });
    await page.getByLabel('From', { exact: true }).fill(from);
    await page.getByLabel('To', { exact: true }).fill(to);
    if (days) await page.getByLabel('Days', { exact: true }).fill(days);
    await page.getByRole('button', { name: 'Record leave' }).click();
  };
  await record('Earned leave', `${APR}-06`, `${APR}-08`);
  await page.getByText('Recorded 3 days of Earned leave for Pooja Nair.').waitFor();
  const balances = page.getByRole('table', { name: 'Leave balances' });
  await balances.getByRole('row', { name: /Earned leave/ }).getByRole('cell', { name: '15', exact: true }).waitFor();

  await record('Leave without pay', `${APR}-20`, `${APR}-21`);
  await page.getByText(`Recorded 2 days of Leave without pay for Pooja Nair; ${run.number} updated.`).waitFor();
  // More earned leave than is left is refused.
  await record('Earned leave', `${APR}-22`, `${APR}-30`, '9');
  await page.getByText('Recorded 9 days').waitFor();
  await record('Earned leave', `${APR}-10`, `${APR}-17`, '7');
  await page.getByText('Only 6 days of Earned leave are left').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-leave.png`, fullPage: true });

  // The draft payslip shows the unpaid leave and pays 28 of 30 days.
  await page.goto(`${WEB}/orgs/${orgId}/payroll/runs/${run.id}`);
  await page.getByText('2 unpaid leave').waitFor();
  let slip = (await call(`${base}/payroll/runs/${run.id}`)).body.payslips[0];
  assert.deepEqual([slip.leaveLopDays, slip.paidDays, slip.gross], ['2.0', '28.0', '28000.00']);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-run-with-leave.png`, fullPage: true });

  // Cancelling the unpaid leave gives the pay back.
  await page.goto(`${WEB}/orgs/${orgId}/payroll/leave`);
  await page.getByRole('table', { name: 'Leave recorded' }).getByRole('row', { name: /Leave without pay/ }).getByRole('button', { name: 'Cancel…' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Reason').fill('Worked from home those days');
  await d.getByRole('button', { name: 'Cancel leave' }).click();
  await page.getByText('Cancelled: Worked from home those days').waitFor();
  slip = (await call(`${base}/payroll/runs/${run.id}`)).body.payslips[0];
  assert.deepEqual([slip.leaveLopDays, slip.paidDays], ['0.0', '30.0']);
  assert.deepEqual(consoleErrors.filter((e) => !/status of 409/.test(e)), []);
});
