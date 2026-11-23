/**
 * Browser end-to-end test for expense categories (EXP-005): finance adds categories on the page,
 * one of them always needing a receipt; the employee picks the category on a claim line and sees
 * its guidance; the claim cannot be submitted until a receipt is attached; the category shows
 * what was claimed. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
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

test('expense categories: finance sets them up, the employee claims under one and needs a receipt', async () => {
  await register(owner, 'Nisha Finance', `e2e-expcat-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Expense Categories Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const email = `e2e-expcat-emp-${randomUUID()}@example.test`;
  await register(employee, 'Rohan Field', email);
  await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));

  // Finance adds two categories on the page.
  await owner.goto(`${base}/expenses/categories`);
  await owner.getByRole('heading', { name: 'Expense categories' }).waitFor();
  await owner.getByText('No categories yet').waitFor();
  const form = owner.getByRole('region', { name: 'Add a category' });
  await form.getByLabel('Name').fill('Hotels');
  await form.getByLabel('Posts to').selectOption({ label: '6700 · Travel' });
  await form.getByLabel('Guidance for employees').fill('Rooms booked for work trips. Attach the hotel folio.');
  await form.getByLabel('Receipt').selectOption('ALWAYS');
  await form.getByRole('button', { name: 'Add category' }).click();
  const table = owner.getByRole('table', { name: 'Categories in use' });
  await table.getByRole('row').filter({ hasText: 'Hotels' }).getByText('Always required').waitFor();
  await form.getByLabel('Name').fill('Software');
  await form.getByLabel('Posts to').selectOption({ label: '6400 · Software and Subscriptions' });
  await form.getByRole('button', { name: 'Add category' }).click();
  await table.getByRole('row').filter({ hasText: 'Software' }).waitFor();
  // The same name again is refused with the reason.
  await form.getByLabel('Name').fill('hotels');
  await form.getByLabel('Posts to').selectOption({ label: '6700 · Travel' });
  await form.getByRole('button', { name: 'Add category' }).click();
  await form.getByText('There is already an active category called hotels').waitFor();
  await form.getByLabel('Name').fill('');

  // The employee picks the category and sees its guidance; no account list is offered.
  await employee.goto(`${base}/expenses/new`);
  await employee.getByLabel('Title').fill('Pune client visit');
  const select = employee.getByLabel('Category for line 1');
  await select.locator('option', { hasText: 'Software' }).waitFor({ state: 'attached' });
  const offered = await select.locator('option').allInnerTexts();
  assert.deepEqual(offered, ['Choose…', 'Hotels', 'Software']);
  await select.selectOption({ label: 'Hotels' });
  await employee.getByTestId('category-guidance-1').getByText('A receipt is always needed.').waitFor();
  assert.match(await employee.getByTestId('category-guidance-1').innerText(), /Rooms booked for work trips/);
  await employee.getByLabel('Merchant for line 1').fill('Synthetic Residency');
  await employee.getByLabel('Amount for line 1').fill('6200');
  if (SHOTS) await employee.screenshot({ path: `${SHOTS}/claim-category-pick.png`, fullPage: true });
  await employee.getByRole('button', { name: 'Save draft' }).click();
  await employee.waitForURL(/\/expenses\/[0-9a-f-]{36}$/);
  const claimId = employee.url().split('/').pop();
  const policy = employee.getByRole('region', { name: 'Expense policy' });
  await policy.getByText('Attach the receipts: Hotels always needs one (line 1) and the claim has none').waitFor();
  await employee.getByRole('cell', { name: /Hotels/ }).first().waitFor();

  // Submitting is refused until a receipt is attached.
  const refused = await call(employee, `${B}/expense-claims/${claimId}/submit`, {});
  assert.equal(refused.status, 422);
  const up = await employee.evaluate(
    async (u) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t2t-csrf': '1' }, body: new TextEncoder().encode('%PDF-1.4\n% synthetic hotel folio 5512\n%%EOF\n') })).status,
    `/api/t2t${B}/attachments?entityType=EXPENSE_CLAIM&entityId=${claimId}&fileName=folio.pdf`,
  );
  assert.equal(up, 201);
  await employee.reload();
  await employee.getByRole('heading', { name: /Pune client visit/ }).waitFor();
  assert.equal(await employee.getByRole('region', { name: 'Expense policy' }).count(), 0);
  await employee.getByRole('button', { name: 'Submit for approval' }).click();
  await employee.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await employee.getByRole('dialog').waitFor({ state: 'detached' });

  // Finance sees what was claimed under each category.
  await owner.reload();
  const hotels = table.getByRole('row').filter({ hasText: 'Hotels' });
  await hotels.getByText('1 line').waitFor();
  assert.match(await hotels.innerText(), /₹6,200\.00/);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/expense-categories.png`, fullPage: true });

  // Archiving takes a category off new claim lines.
  await owner.getByRole('button', { name: 'Archive Software' }).click();
  await owner.getByRole('table', { name: 'Archived categories' }).getByText('Software', { exact: true }).waitFor();
  await employee.goto(`${base}/expenses/new`);
  await employee.getByLabel('Category for line 1').locator('option', { hasText: 'Hotels' }).waitFor({ state: 'attached' });
  assert.deepEqual(await employee.getByLabel('Category for line 1').locator('option').allInnerTexts(), ['Choose…', 'Hotels']);
  assert.deepEqual(consoleErrors.filter((e) => !/422|Unprocessable/.test(e)), []);
  // Employees cannot change the list.
  assert.equal((await call(employee, `${B}/expense-categories`, { name: 'Mine', accountId: '00000000-0000-4000-8000-000000000000', receipt: 'POLICY' })).status, 403);
});
