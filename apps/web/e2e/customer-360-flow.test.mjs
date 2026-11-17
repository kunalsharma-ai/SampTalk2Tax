/**
 * Browser end-to-end test for Customer 360: an owner links a project to a customer, posts an
 * invoice, a receipt and a bill on the project, then reads the customer's profit, payment
 * behaviour, lifetime value and credit risk; applies the suggested credit limit; puts the customer
 * on credit hold (an invoice then cannot post) and lifts it; and ranks customers on the insights
 * page. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
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

test('a customer 360 shows profit, risk and lifetime value, and a credit hold stops invoices', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Insight Owner');
  await page.getByLabel('Email').fill(`e2e-c360-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Insights Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const orgId = base.split('/orgs/')[1];
  const B = `/v1/orgs/${orgId}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const customer = await must(call(`${B}/contacts`, { name: 'Nair Logistics', isCustomer: true, paymentTermsDays: 30 }));
  const vendor = await must(call(`${B}/contacts`, { name: 'Teak Supplies', isVendor: true }));
  const fy = await must(call(`${B}/periods`));
  if (!fy.some((p) => p.startDate <= addDays(T, -60))) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(fy[0].startDate.slice(0, 4)) - 1 });

  // A project for the customer, linked on the departments and projects page.
  await page.goto(`${base}/dimensions`);
  await page.getByRole('tab', { name: /Projects/ }).click();
  const addP = page.getByLabel('Add a project');
  await addP.getByLabel('Code').fill('NAIR-AMC');
  await addP.getByLabel('Name', { exact: true }).fill('Nair warehouse upkeep');
  await addP.getByLabel('Customer (optional)').locator('option', { hasText: 'Nair Logistics' }).waitFor({ state: 'attached' });
  await addP.getByLabel('Customer (optional)').selectOption({ label: 'Nair Logistics' });
  await addP.getByRole('button', { name: 'Add project' }).click();
  await page.getByRole('link', { name: 'Nair Logistics' }).waitFor();
  const project = (await must(call(`${B}/dimensions?type=PROJECT`))).values[0];

  // Billed 60 days ago and paid five days early; costs on the project.
  const inv = await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: addDays(T, -60), dueDate: addDays(T, -30), post: true, lines: [{ accountId: acc('4100'), quantity: '1', unitPrice: '120000' }] }));
  await must(call(`${B}/sales/payments`, { contactId: customer.id, date: addDays(T, -35), bankAccountId: acc('1120'), amount: '120000.00', allocations: [{ documentId: inv.id, amount: '120000.00' }] }));
  await must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, reference: 'TS-9', issueDate: addDays(T, -40), dueDate: addDays(T, -10), post: true, lines: [{ accountId: acc('6400'), quantity: '1', unitPrice: '30000', projectId: project.id }] }));

  await page.goto(`${base}/sales/customers/${customer.id}`);
  const c360 = page.getByRole('region', { name: 'Customer 360' });
  await c360.getByRole('heading', { name: 'Customer 360' }).waitFor();
  await c360.getByText('Margin 75% on ₹1,20,000.00 revenue').waitFor();
  const months = c360.getByRole('table', { name: 'Monthly profitability' });
  assert.equal(await months.locator('tbody tr').count(), 12);
  await months.locator('tfoot').getByText('₹90,000.00').first().waitFor();
  await c360.getByRole('list', { name: 'Customer projects' }).getByText('NAIR-AMC').waitFor();
  await c360.getByText('Low risk · 0').first().waitFor();
  await c360.getByRole('table', { name: 'Credit risk factors' }).getByText('Paid on time on average').waitFor();
  await c360.getByText('Fewer than five customers were billed a year before last, so three years is assumed.').waitFor();
  // Lifetime value: 90,000 earned + 90,000 a year × 3 years.
  await c360.getByText('₹3,60,000.00').first().waitFor();

  // The suggested limit: a month of billing (10,000) plus 30 days of terms, rounded up.
  await c360.getByRole('button', { name: 'Use ₹20,000.00 as the credit limit' }).click();
  await c360.getByText('Credit limit: ₹20,000.00.').waitFor();

  // Credit hold: an invoice to them cannot post until it is lifted.
  await c360.getByRole('button', { name: 'Put on credit hold' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Why is it on hold?').fill('Disputed delivery, awaiting their sign-off');
  await dlg.getByRole('button', { name: 'Put on hold' }).click();
  await page.getByRole('alert').filter({ hasText: 'On credit hold' }).getByText('Disputed delivery, awaiting their sign-off').waitFor();
  await page.getByText('On credit hold', { exact: true }).first().waitFor();
  const draft = await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, dueDate: addDays(T, 30), lines: [{ accountId: acc('4100'), quantity: '1', unitPrice: '5000' }] }));
  await page.goto(`${base}/sales/invoices/${draft.id}`);
  await page.getByRole('button', { name: 'Post' }).first().click();
  await page.getByText('is on credit hold (Disputed delivery, awaiting their sign-off)').waitFor();

  // Ranked on the insights page, and found under "On credit hold".
  await page.getByRole('link', { name: 'Customer insights', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Customer insights' }).waitFor();
  const table = page.getByRole('table', { name: 'Customer insights' });
  await table.getByRole('row', { name: /Nair Logistics.*On hold.*₹3,60,000\.00/ }).waitFor();
  await page.getByLabel('Show').selectOption('HOLD');
  await table.getByText('Nair Logistics').waitFor();
  await page.getByLabel('Show').selectOption('HIGH');
  await page.getByText('No customers here').waitFor();

  // Lift the hold; the invoice posts.
  await page.goto(`${base}/sales/customers/${customer.id}`);
  await page.getByRole('button', { name: 'Lift the hold' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lift the hold' }).click();
  await page.getByRole('button', { name: 'Put on credit hold' }).waitFor();
  assert.equal((await call(`${B}/sales/documents/${draft.id}/post`, { overrideCreditLimit: false })).status, 200);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
