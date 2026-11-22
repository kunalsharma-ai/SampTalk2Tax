/**
 * Browser end-to-end test for department budgets (EXP-014): the owner adds two departments and
 * sets a budget on the page; an approved claim has spent most of Sales' budget; the employee
 * writes a claim on Sales in the claim form; the owner sees on the waiting claim that approving it
 * takes Sales over, and the budgets page shows Sales at risk. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, owner, employee;
const consoleErrors = [];

async function call(page, path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };
async function register(page, name, email) {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
}

before(async () => {
  browser = await chromium.launch();
  owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  employee = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, employee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('department budgets: set one, claim against it, and see the warning before approving', async () => {
  await register(owner, 'Tara Budget', `e2e-deptb-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Department Budgets Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const dept = {};
  for (const [code, name] of [['SALES', 'Sales'], ['OPS', 'Operations']]) dept[code] = (await must(call(owner, `${B}/dimensions`, { type: 'DEPARTMENT', code, name }))).id;
  const email = `e2e-deptb-emp-${randomUUID()}@example.test`;
  await register(employee, 'Dev Seller', email);
  await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));
  // Sales has already spent 4,000 this year on an approved claim.
  const first = await must(call(employee, `${B}/expense-claims`, { title: 'Trade fair', lines: [{ date: T, accountId: acc['6700'], merchant: 'Synthetic Travels', amount: '4000.00', departmentId: dept.SALES }] }));
  await must(call(employee, `${B}/expense-claims/${first.id}/submit`, {}));
  await must(call(owner, `${B}/expense-claims/${first.id}/approve`, {}));

  // The owner sets Sales' budget for the year on the page.
  await owner.goto(`${base}/expenses/department-budgets`);
  await owner.getByRole('heading', { name: 'Department budgets' }).waitFor();
  const table = owner.getByRole('table', { name: 'Budget by department' });
  await table.getByRole('row').filter({ hasText: 'Sales' }).getByText('No budget set for this year').waitFor();
  await owner.getByRole('button', { name: 'Set budget for Sales' }).click();
  await owner.getByLabel('Budget for the year').fill('5000');
  await owner.getByLabel('Note').fill('Trade fairs and client visits');
  await owner.getByRole('button', { name: 'Save budget' }).click();
  await table.getByText('Trade fairs and client visits').waitFor();
  await owner.getByLabel('Department', { exact: true }).selectOption({ label: 'OPS · Operations' });
  await owner.getByLabel('Budget for the year').fill('100000');
  await owner.getByRole('button', { name: 'Save budget' }).click();
  await table.getByRole('row').filter({ hasText: 'Operations' }).getByText('On track').waitFor();

  // The employee writes a claim on Sales in the claim form.
  await employee.goto(`${base}/expenses/new`);
  await employee.getByLabel('Title').fill('Client lunch');
  await employee.getByLabel('Category for line 1').selectOption({ label: '6700 · Travel' });
  await employee.getByLabel('Merchant for line 1').fill('Synthetic Diner');
  await employee.getByLabel('Amount for line 1').fill('1500');
  await employee.getByLabel('Department for line 1').selectOption({ label: 'SALES · Sales' });
  await employee.getByRole('button', { name: 'Save draft' }).click();
  await employee.waitForURL(/\/expenses\/[0-9a-f-]{36}$/);
  await employee.getByText('Department: SALES · Sales').waitFor();
  await employee.getByRole('button', { name: 'Submit for approval' }).click();
  await employee.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await employee.getByRole('dialog').waitFor({ state: 'detached' });
  const claimUrl = employee.url();

  // The owner sees what approving would do to the budget.
  await owner.goto(claimUrl);
  const warning = owner.getByRole('region', { name: 'Department budgets' });
  await warning.getByText('Approving takes a department over its budget').waitFor();
  assert.match(await warning.innerText(), /Sales: ₹1,500\.00 on this claim; ₹1,000\.00 left of ₹5,000\.00, ₹500\.00 over after approval/);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/department-budget-warning.png`, fullPage: true });

  await owner.goto(`${base}/expenses/department-budgets`);
  const sales = table.getByRole('row').filter({ hasText: 'Sales' });
  await sales.getByText('At risk').waitFor();
  assert.match(await sales.innerText(), /Claims waiting for approval would take it ₹500\.00 over/);
  assert.match(await sales.innerText(), /80\.0% used/);
  await owner.getByText('0 over, 1 at risk').waitFor();
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/department-budgets.png`, fullPage: true });

  assert.deepEqual(consoleErrors, []);
  // The employee cannot read the budgets.
  assert.equal((await call(employee, `${B}/department-budgets`)).status, 403);
});
