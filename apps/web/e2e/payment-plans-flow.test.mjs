/**
 * Browser end-to-end test for suggested payment plans (AR-040): an owner records a customer who
 * has paid about 20,000 a month lately and now owes 90,000 overdue; Payment plans suggests 5
 * instalments of 18,000; the owner sets up a 6-instalment plan from the dialog (the schedule
 * follows the choice), a receipt pays the first instalment, and the owner cancels the plan with a
 * reason. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a suggested plan is set up, paid against and cancelled', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Pallavi Plans');
  await page.getByLabel('Email').fill(`e2e-plans-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Plans Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const fy = await must(call(`${B}/periods`));
  if (!fy.some((p) => p.startDate <= addDays(T, -150))) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(fy[0].startDate.slice(0, 4)) - 1 });
  const mehta = await must(call(`${B}/contacts`, { name: 'Mehta Mart', isCustomer: true }));
  const invoice = (issueDate, amount) => must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: mehta.id, issueDate, dueDate: addDays(issueDate, 30), post: true, lines: [{ accountId: acc('4100'), quantity: '1', unitPrice: amount }] }));
  const receipt = (date, documentId, amount) => must(call(`${B}/sales/payments`, { contactId: mehta.id, date, bankAccountId: acc('1120'), amount, allocations: [{ documentId, amount }] }));
  await receipt(addDays(T, -100), (await invoice(addDays(T, -150), '60000')).id, '60000.00');
  await receipt(addDays(T, -20), (await invoice(addDays(T, -60), '60000')).id, '60000.00');
  const oldest = await invoice(addDays(T, -70), '60000');
  await invoice(addDays(T, -40), '30000');

  await page.goto(`${base}/sales/payment-plans`);
  const offers = page.getByRole('table', { name: 'Customers to offer a plan' });
  await offers.waitFor();
  const row = offers.locator('tbody tr').first();
  const text = await row.innerText();
  assert.match(text, /Mehta Mart/);
  assert.match(text, /90,000\.00/);
  assert.match(text, /5 × .*18,000\.00/);
  assert.match(text, /about 20000\.00 a month/);
  await row.getByRole('button', { name: 'Set up plan' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Payment plan for Mehta Mart').waitFor();
  assert.equal(await dialog.getByRole('table', { name: 'Instalment schedule' }).locator('tbody tr').count(), 5);
  await dialog.getByLabel('Instalments').selectOption('6');
  await dialog.getByRole('table', { name: 'Instalment schedule' }).locator('tbody tr').nth(5).waitFor();
  assert.match(await dialog.getByRole('table', { name: 'Instalment schedule' }).innerText(), /15,000\.00/);
  await dialog.getByLabel('Note (optional)').fill('Agreed with Mr Mehta on a call');
  await dialog.getByRole('button', { name: 'Agree plan' }).click();
  await dialog.waitFor({ state: 'hidden' });

  const plans = page.getByRole('table', { name: 'Agreed payment plans' });
  await plans.locator('tbody tr').first().getByText('On track').waitFor();
  await page.getByText('No one to offer a plan').waitFor();
  await receipt(T, oldest.id, '15000.00');
  await page.reload();
  const plan = plans.locator('tbody tr').first();
  await plan.getByText('1 of 6 paid').waitFor();
  assert.match(await plan.innerText(), /PP-001/);
  await plan.getByText('1 of 6 paid').click();
  await plan.getByText(/1\. .*Paid/).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/payment-plans.png`, fullPage: true });

  await plan.getByRole('button', { name: 'Cancel plan' }).click();
  await page.getByRole('dialog').getByLabel('Why is it cancelled?').fill('Customer asked to pay in full next month');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel plan' }).click();
  await plan.getByText('Cancelled', { exact: true }).waitFor();
  await page.getByRole('table', { name: 'Customers to offer a plan' }).getByText('Mehta Mart').waitFor();
  assert.deepEqual(consoleErrors, []);
});
