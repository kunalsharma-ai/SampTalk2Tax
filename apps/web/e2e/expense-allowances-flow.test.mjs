/**
 * Browser end-to-end test for mileage and per diem claims: the owner sets a mileage rate and a
 * per diem rate, an employee claims a trip with both plus a receipt (amounts worked out as they
 * type, then on the server), and the approved claim posts to the rates' account.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, owner, employee, orgId, claimUrl;
const consoleErrors = [];
const employeeEmail = `e2e-allowance-${randomUUID()}@example.test`;
const shot = (p, name, fullPage = false) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage }) : undefined);

async function call(page, path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
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
  await page.waitForURL(/\/onboarding/);
}

before(async () => {
  browser = await chromium.launch();
  owner = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  employee = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, employee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the owner sets mileage and per diem rates', async () => {
  await register(owner, 'Rates Owner', `e2e-rates-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Allowances Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = owner.url().split('/').pop();
  await register(employee, 'Travelling Employee', employeeEmail);
  assert.equal((await call(owner, `/v1/orgs/${orgId}/members`, { email: employeeEmail, role: 'EMPLOYEE' })).status, 201);

  await owner.goto(`${WEB}/orgs/${orgId}/expenses`);
  await owner.getByRole('link', { name: 'Mileage and per diem rates' }).click();
  await owner.getByRole('heading', { name: 'Mileage and per diem rates' }).waitFor();
  await owner.getByText('No rates yet.', { exact: false }).waitFor();
  await owner.getByLabel('Name').fill('Car');
  await owner.getByLabel('Rate in INR').fill('9.50');
  await owner.getByLabel('Expense account').selectOption({ label: '6700 · Travel' });
  await owner.getByRole('button', { name: 'Add rate' }).click();
  await owner.getByRole('row', { name: /Car/ }).waitFor();

  await owner.getByLabel('Kind').selectOption('PER_DIEM');
  await owner.getByLabel('Name').fill('Metro city');
  await owner.getByLabel('Rate in INR').fill('2500.555');
  assert.equal(await owner.getByLabel('Rate in INR').inputValue(), '2500.555');
  await owner.getByRole('button', { name: 'Add rate' }).click();
  await owner.getByText('A daily rate has at most 2 decimal places in INR').waitFor();
  await owner.getByLabel('Rate in INR').fill('2500');
  await owner.getByRole('button', { name: 'Add rate' }).click();
  await owner.getByRole('row', { name: /Metro city/ }).waitFor();
  await shot(owner, '01-rates', true);
});

test('the employee claims mileage, per diem and a receipt', async () => {
  await employee.goto(`${WEB}/orgs/${orgId}/expenses/new`);
  await employee.getByLabel('Title').fill('Mumbai client visit');
  await employee.getByLabel('Kind of line 1').selectOption('MILEAGE');
  await employee.getByLabel('Mileage rate for line 1').selectOption({ label: 'Car · ₹9.50 per km' });
  await employee.getByLabel('From for line 1').fill('Pune');
  await employee.getByLabel('To for line 1').fill('Mumbai');
  await employee.getByLabel('Purpose for line 1').fill('Client visit');
  await employee.getByLabel('Kilometres for line 1').fill('148.5');
  await employee.getByText('= ₹1,410.75').waitFor();

  await employee.getByRole('button', { name: '+ Add per diem' }).click();
  await employee.getByLabel('Per diem rate for line 2').selectOption({ label: 'Metro city · ₹2,500.00 per day' });
  await employee.getByLabel('Place for line 2').fill('Mumbai');
  await employee.getByLabel('Days for line 2').fill('1.5');
  await employee.getByText('= ₹3,750.00').waitFor();

  await employee.getByRole('button', { name: '+ Add receipt' }).click();
  await employee.getByLabel('Category for line 3').selectOption({ label: '6700 · Travel' });
  await employee.getByLabel('Merchant for line 3').fill('Synthetic Tolls');
  await employee.getByLabel('Amount for line 3').fill('320');
  await employee.getByText('₹5,480.75').waitFor();
  await shot(employee, '02-claim-form', true);

  await employee.getByRole('button', { name: 'Save draft' }).click();
  await employee.waitForURL(/\/expenses\/[0-9a-f-]{36}$/);
  claimUrl = employee.url();
  await employee.getByText('Mileage 148.5 km × 9.50 (Car), Pune to Mumbai: Client visit').waitFor();
  await employee.getByText('Per diem 1.5 days × 2500 (Metro city), Mumbai').waitFor();
  await shot(employee, '03-claim-detail', true);
  await employee.getByRole('button', { name: 'Submit for approval' }).click();
  await employee.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await employee.getByText('Waiting for approval').first().waitFor();
});

test('the owner approves it and it posts to Travel', async () => {
  const id = claimUrl.split('/').pop();
  const approved = await call(owner, `/v1/orgs/${orgId}/expense-claims/${id}/approve`, {});
  assert.equal(approved.status, 200);
  const je = await call(owner, `/v1/orgs/${orgId}/journals/${approved.body.journalEntryId}`);
  const debits = je.body.lines.filter((l) => Number(l.debit) > 0).map((l) => l.debit);
  assert.deepEqual(debits, ['1410.75', '3750.00', '320.00']);
  const unexpected = consoleErrors.filter((e) => !/status of 422/.test(e));
  assert.deepEqual(unexpected, []);
});
