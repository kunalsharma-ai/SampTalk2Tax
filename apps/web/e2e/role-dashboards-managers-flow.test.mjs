/**
 * Browser end-to-end test for the manager dashboards (DASH-049/050/051/055): an owner with late
 * invoices, a late bill and a claim waiting opens the receivables manager's dashboard from the
 * address, reads the ageing and the overdue customers, switches to payables, the tax manager and
 * expenses, and opens the waiting claim. Real Next.js app → real API → real MongoDB.
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
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const d = (k) => new Date(Date.parse(`${T}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const weekday = (k) => (new Date(`${d(k)}T00:00:00Z`).getUTCDay() === 0 ? d(k - 1) : d(k));

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner reads the receivables, payables, tax and expense dashboards', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Managers');
  await page.getByLabel('Email').fill(`e2e-managers-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Manager Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const periods = ok(await call(`${base}/periods`), 'periods');
  if (!periods.some((p) => p.startDate <= d(-110))) await call(`${base}/periods/fiscal-years`, { fiscalYear: Number(periods[0].startDate.slice(0, 4)) - 1 });
  const id = {};
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods']) id[name] = ok(await call(`${base}/contacts`, { name, isCustomer: true }), name).id;
  for (const name of ['Granite Supplies', 'Harbour Freight']) id[name] = ok(await call(`${base}/contacts`, { name, isVendor: true }), name).id;
  for (const [who, amount, issue, due] of [['Asha Traders', '450000.00', -80, -50], ['Banyan Retail', '300000.00', -20, 10], ['Cedar Foods', '150000.00', -110, -95]]) ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: id[who], issueDate: d(issue), dueDate: d(due), post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] }), who);
  for (const [who, amount, ref, due] of [['Granite Supplies', '60000.00', 'G-1', -10], ['Harbour Freight', '40000.00', 'H-1', 15]]) ok(await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: id[who], issueDate: d(-40), dueDate: d(due), reference: ref, post: true, lines: [{ accountId: acc['6100'], quantity: '1', unitPrice: amount }] }), who);
  const claim = ok(await call(`${base}/expense-claims`, { title: 'Client visit', lines: [{ date: weekday(-3), accountId: acc['6700'], merchant: 'Synthetic Cabs', amount: '2400.00' }] }), 'claim');
  ok(await call(`${base}/expense-claims/${claim.id}/submit`, {}), 'submit');
  consoleErrors = [];
  const shot = async (name) => SHOTS && (await page.screenshot({ path: `${SHOTS}/role-dashboards-${name}.png`, fullPage: true }));

  // Receivables: ageing and the overdue customers.
  await page.goto(`${WEB}/orgs/${orgId}/reports/role-dashboards?role=AR_MANAGER`);
  const tabs = page.getByRole('tablist', { name: 'Dashboard for' });
  const ageing = page.getByRole('table', { name: 'Receivables by age figures' });
  await ageing.getByRole('row', { name: /31–60 days late 1 ₹4,50,000\.00 50\.0%/ }).waitFor();
  await ageing.getByRole('row', { name: /Over 90 days late 1 ₹1,50,000\.00/ }).waitFor();
  await page.getByRole('img', { name: /Open amounts by how late they are/ }).waitFor();
  const late = page.getByRole('list', { name: 'Customers with overdue balances' });
  await late.getByRole('link', { name: 'Asha Traders' }).waitFor();
  await late.getByText('1 invoice, the oldest 95 days late').waitFor();
  assert.equal(await late.getByRole('listitem').count(), 2);
  await page.getByRole('table', { name: 'Expected collections by week' }).waitFor();
  await shot('receivables');

  // Payables: ageing and the bills in order.
  await tabs.getByRole('tab', { name: 'Payables', exact: true }).click();
  await page.waitForURL(/role=AP_MANAGER/);
  await page.getByRole('table', { name: 'Payables by age figures' }).getByRole('row', { name: /1–30 days late 1 ₹60,000\.00/ }).waitFor();
  await page.getByRole('table', { name: 'Bills for the payables manager' }).getByRole('row', { name: /Granite Supplies/ }).waitFor();
  await page.getByRole('region', { name: 'Held bills' }).getByText(/0 held/).waitFor();
  await page.getByRole('region', { name: 'Payment checks' }).waitFor();
  await shot('payables');

  // Tax manager: the GST check and returns.
  await tabs.getByRole('tab', { name: 'Tax manager', exact: true }).click();
  await page.waitForURL(/role=TAX_MANAGER/);
  await page.getByRole('region', { name: 'GST books against documents' }).waitFor();
  await page.getByRole('region', { name: 'Returns and their risk' }).waitFor();
  await page.getByRole('region', { name: 'Tax by area' }).waitFor();
  await shot('tax-manager');

  // Expenses: the claim waiting, then open it.
  await tabs.getByRole('tab', { name: 'Expenses', exact: true }).click();
  await page.waitForURL(/role=EXPENSE_MANAGER/);
  await page.getByRole('group', { name: 'Claims waiting' }).getByText('1', { exact: true }).waitFor();
  const waiting = page.getByRole('table', { name: 'Claims to decide' });
  await waiting.getByRole('row', { name: /Client visit Dev Managers .*₹2,400\.00/ }).waitFor();
  await page.getByRole('region', { name: 'Budgets by department' }).getByText(/No departments yet/).waitFor();
  await shot('expenses');
  await waiting.getByRole('link', { name: 'Client visit' }).click();
  await page.waitForURL(new RegExp(`/expenses/${claim.id}$`));
  assert.deepEqual(consoleErrors, []);
});
