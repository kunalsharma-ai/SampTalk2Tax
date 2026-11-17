/**
 * Browser end-to-end test for the expense policy: the owner sets a limit per receipt for Travel
 * (warns) and a receipt rule (blocks); an employee's claim shows both, cannot be submitted until
 * a receipt is attached, and the owner must give a reason to approve it outside the policy.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let browser, owner, employee, orgId, claimUrl;
const consoleErrors = [];
const employeeEmail = `e2e-policy-${randomUUID()}@example.test`;
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

test('the owner sets the expense policy', async () => {
  await register(owner, 'Policy Owner', `e2e-policy-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Expense Policy Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = owner.url().split('/').pop();
  await register(employee, 'Spending Employee', employeeEmail);
  assert.equal((await call(owner, `/v1/orgs/${orgId}/members`, { email: employeeEmail, role: 'EMPLOYEE' })).status, 201);

  await owner.goto(`${WEB}/orgs/${orgId}/expenses`);
  await owner.getByRole('link', { name: 'Expense policy' }).click();
  await owner.getByRole('heading', { name: 'Expense policy' }).waitFor();
  await owner.getByText('No rules yet.', { exact: false }).waitFor();
  await owner.getByLabel('Amount in INR').fill('2000');
  await owner.getByLabel('Category').selectOption({ label: '6700 · Travel' });
  await owner.getByRole('button', { name: 'Add rule' }).click();
  await owner.getByRole('row', { name: /At most INR 2000.00 per receipt for 6700 · Travel/ }).waitFor();

  await owner.getByLabel('Rule').selectOption('RECEIPT_ABOVE');
  assert.ok(await owner.getByLabel('Category').isDisabled());
  await owner.getByLabel('Amount in INR').fill('500');
  await owner.getByLabel('When broken').selectOption('BLOCK');
  await owner.getByRole('button', { name: 'Add rule' }).click();
  await owner.getByRole('row', { name: /Receipts attached for any receipt line over INR 500.00 Blocks submission/ }).waitFor();

  // A rule is changed in place.
  await owner.getByRole('button', { name: 'Change At most INR 2000.00 per receipt for 6700 · Travel' }).click();
  await owner.getByLabel('Amount', { exact: true }).fill('2200');
  await owner.getByRole('button', { name: 'Save' }).click();
  await owner.getByRole('row', { name: /At most INR 2200.00 per receipt/ }).waitFor();
  await shot(owner, '01-policy', true);
});

test('the employee sees what the claim breaks and fixes the blocking part', async () => {
  await employee.goto(`${WEB}/orgs/${orgId}/expenses/new`);
  await employee.getByLabel('Title').fill('Delhi flight');
  await employee.getByLabel('Category for line 1').selectOption({ label: '6700 · Travel' });
  await employee.getByLabel('Merchant for line 1').fill('Synthetic Air');
  await employee.getByLabel('Amount for line 1').fill('2500');
  await employee.getByRole('button', { name: 'Save draft' }).click();
  await employee.waitForURL(/\/expenses\/[0-9a-f-]{36}$/);
  claimUrl = employee.url();

  const region = employee.getByRole('region', { name: 'Expense policy' });
  await region.getByText('Line 1: INR 2500.00 is over the limit of INR 2200.00 per receipt for 6700 · Travel').waitFor();
  await region.getByText('Attach the receipts: line 1 is over INR 500.00 and the claim has no receipt attached').waitFor();
  await region.getByText('This claim cannot be submitted until the blocking items are fixed.').waitFor();
  await shot(employee, '02-claim-outside-policy');

  await employee.getByRole('button', { name: 'Submit for approval' }).click();
  const dialog = employee.getByRole('dialog');
  await dialog.getByText('Outside the expense policy').waitFor();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await dialog.getByText('The claim breaks the expense policy').waitFor();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await employee.getByLabel('Attach files').setInputFiles({ name: 'flight.pdf', mimeType: 'application/pdf', buffer: PDF });
  await employee.getByRole('link', { name: 'flight.pdf' }).waitFor();
  await region.getByText('Attach the receipts', { exact: false }).waitFor({ state: 'detached' });
  await region.getByText('You can submit it, but the approver must say why they approve it anyway.').waitFor();
  await employee.getByRole('button', { name: 'Submit for approval' }).click();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await dialog.waitFor({ state: 'detached' });
  await employee.getByText('Waiting for approval').first().waitFor();
});

test('the owner gives a reason to approve it outside the policy', async () => {
  await owner.goto(claimUrl);
  await owner.getByRole('region', { name: 'Expense policy' }).getByText('Outside the policy: the approver must say why they approve it anyway.').waitFor();
  await owner.getByRole('button', { name: 'Approve…' }).click();
  const dialog = owner.getByRole('dialog');
  const why = dialog.getByLabel('Why approve it anyway');
  await why.waitFor();
  assert.ok(await why.evaluate((el) => el.required));
  await why.fill('Only flight that reached the client in time');
  await shot(owner, '03-approve-outside-policy');
  await dialog.getByRole('button', { name: 'Approve and post' }).click();
  await dialog.waitFor({ state: 'detached' });
  await owner.getByText('“Only flight that reached the client in time”').waitFor();
  assert.equal(await owner.getByRole('region', { name: 'Expense policy' }).count(), 0);
  const unexpected = consoleErrors.filter((e) => !/status of 422/.test(e));
  assert.deepEqual(unexpected, []);
});
