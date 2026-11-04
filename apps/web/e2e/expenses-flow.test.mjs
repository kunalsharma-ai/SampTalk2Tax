/**
 * Browser end-to-end test for employee expense claims: an employee (who sees nothing
 * of the books) writes a claim with a tax-inclusive line, attaches a receipt and
 * submits it; the owner approves it, which posts it, and pays it back from the bank.
 * Real Next.js app → real API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PDF = Buffer.from('%PDF-1.4\n% synthetic e2e cab receipt\n%%EOF\n');
const todayIso = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, owner, employee, orgId, claimUrl;
const consoleErrors = [];
const employeeEmail = `e2e-employee-${randomUUID()}@example.test`;

async function call(page, path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}

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
  for (const p of [owner, employee]) {
    p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    p.on('dialog', (d) => d.accept());
  }
});
after(async () => browser?.close());

test('an owner adds a tax rate and an employee', async () => {
  await register(owner, 'Claims Owner', `e2e-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Expenses Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = owner.url().split('/').pop();
  const acc = Object.fromEntries((await call(owner, `/v1/orgs/${orgId}/accounts`)).body.map((a) => [a.code, a.id]));
  assert.equal((await call(owner, `/v1/orgs/${orgId}/tax-rates`, { name: 'GST 18%', rate: '18', salesAccountId: acc['2300'], purchaseAccountId: acc['1450'] })).status, 201);
  await register(employee, 'Field Employee', employeeEmail);
  assert.equal((await call(owner, `/v1/orgs/${orgId}/members`, { email: employeeEmail, role: 'EMPLOYEE' })).status, 201);
});

test('the employee sees only their claims and writes one with live totals', async () => {
  await employee.goto(`${WEB}/orgs/${orgId}`);
  await employee.waitForURL(/\/expenses$/);
  await employee.getByRole('heading', { name: 'My expense claims' }).waitFor();
  const nav = await employee.getByRole('navigation', { name: 'Main' }).getByRole('link').allTextContents();
  assert.deepEqual(nav, ['My expense claims']);
  await employee.getByText('No claims yet').waitFor();

  await employee.getByRole('link', { name: 'New claim' }).click();
  await employee.getByLabel('Title').fill('Client visit, Pune');
  await employee.getByLabel('Category for line 1').selectOption({ label: '6700 · Travel' });
  await employee.getByLabel('Merchant for line 1').fill('Synthetic Cabs');
  await employee.getByLabel('Amount for line 1').fill('1180');
  await employee.getByLabel('Tax for line 1').selectOption({ label: 'GST 18%' });
  await employee.getByText('incl. tax ₹180.00').first().waitFor();
  await employee.getByRole('button', { name: '+ Add line' }).click();
  await employee.getByLabel('Category for line 2').selectOption({ label: '6700 · Travel' });
  await employee.getByLabel('Merchant for line 2').fill('Synthetic Diner');
  await employee.getByLabel('Amount for line 2').fill('450.50');
  await employee.getByText('₹1,630.50').waitFor();
  await employee.getByRole('button', { name: 'Save draft' }).click();
  await employee.waitForURL(/\/expenses\/[0-9a-f-]{36}$/);
  claimUrl = employee.url();
  await employee.getByRole('heading', { name: 'EXP-000001 · Client visit, Pune' }).waitFor();
});

test('the employee attaches a receipt and submits the claim', async () => {
  await employee.getByText('No receipts attached yet.').waitFor();
  await employee.getByLabel('Attach files').setInputFiles({ name: 'cab-receipt.pdf', mimeType: 'application/pdf', buffer: PDF });
  await employee.getByRole('link', { name: 'cab-receipt.pdf' }).waitFor();
  await employee.getByRole('button', { name: 'Submit for approval' }).click();
  await employee.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await employee.getByRole('dialog').waitFor({ state: 'detached' });
  await employee.getByText('Waiting for approval').first().waitFor();
  assert.equal(await employee.getByRole('button', { name: 'Approve…' }).count(), 0);
  await employee.getByRole('button', { name: 'Withdraw' }).waitFor();
});

test('the owner approves it, which posts it, and pays it back', async () => {
  await owner.goto(`${WEB}/orgs/${orgId}/expenses`);
  await owner.getByRole('tab', { name: /To approve/ }).click();
  await owner.getByRole('row', { name: /Field Employee/ }).getByRole('link', { name: 'EXP-000001' }).click();
  await owner.getByRole('link', { name: 'cab-receipt.pdf' }).waitFor();
  await owner.getByRole('button', { name: 'Approve…' }).click();
  let dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Note (optional)').fill('Within travel policy');
  await dialog.getByRole('button', { name: 'Approve and post' }).click();
  await dialog.waitFor({ state: 'detached' });
  await owner.getByText('Approved, to be paid').waitFor();
  await owner.getByRole('link', { name: 'Expense journal' }).waitFor();

  await owner.getByRole('button', { name: 'Pay back…' }).click();
  dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Paid from').selectOption({ label: '1120 · Operating Bank Account' });
  await dialog.getByLabel('Reference (optional)').fill('NEFT SYN-001');
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await dialog.waitFor({ state: 'detached' });
  await owner.getByText('Ref NEFT SYN-001').waitFor();
  await owner.getByText('1120 · Operating Bank Account').waitFor();
  await owner.getByRole('link', { name: 'Expense journal' }).click();
  await owner.getByText('Created by an expense claim (EXP-000001)').waitFor();
});

test('the employee sees it paid back', async () => {
  await employee.goto(claimUrl);
  await employee.getByText('Ref NEFT SYN-001').waitFor();
  // Employees do not get links into the books.
  assert.equal(await employee.getByRole('link', { name: 'Expense journal' }).count(), 0);
  assert.equal(await employee.getByRole('button', { name: 'Attach files' }).count(), 0);
  await employee.goto(`${WEB}/orgs/${orgId}/expenses`);
  await employee.getByText('Paid back').first().waitFor();
});

test('no unexpected console errors were logged', () => {
  assert.deepEqual(consoleErrors.filter((e) => !/favicon/.test(e)), [], consoleErrors.join('\n'));
});
