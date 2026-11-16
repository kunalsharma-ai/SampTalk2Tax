/**
 * Browser end-to-end test for business impact: an owner starts from "win a new customer",
 * adds a hire, assesses and saves it, adds equipment, sees each change and each business area,
 * turns the assessment into a digital-twin scenario and deletes it.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));
const LAST = shift(T.slice(0, 7), -1);
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

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => {
  await browser?.close();
});

test('an owner assesses winning a customer with a hire, adds equipment, and opens it as a twin scenario', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Indra Impact');
  await page.getByLabel('Email').fill(`e2e-impact-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Impact Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!years.has(fyOf(LAST))) ok(await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(LAST) }), 'fiscal year');
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const acme = ok(await call(`${base}/contacts`, { name: 'Acme Retail', isCustomer: true }), 'acme').id;
  const granite = ok(await call(`${base}/contacts`, { name: 'Granite Parts', isVendor: true }), 'granite').id;
  ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: acme, issueDate: `${LAST}-01`, dueDate: `${LAST}-28`, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '400000.00' }] }), 'invoice');
  ok(await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: granite, issueDate: `${LAST}-05`, reference: 'GP-1', post: true, lines: [{ accountId: acc['5000'], quantity: '1', unitPrice: '120000.00' }] }), 'bill');
  ok(await call(`${base}/journals`, { date: `${LAST}-15`, memo: 'Capital', post: true, lines: [{ accountId: acc['1120'], debit: '1000000.00' }, { accountId: acc['3100'], credit: '1000000.00' }] }), 'capital');

  await page.getByRole('link', { name: 'Business impact' }).click();
  await page.getByRole('heading', { name: 'Business impact' }).waitFor();
  await page.getByText('No saved assessments yet').waitFor();
  await page.getByRole('region', { name: 'People (HR)' }).getByRole('link', { name: 'Hire people' }).waitFor();
  await page.getByRole('link', { name: 'Win a new customer or contract' }).click();
  await page.getByRole('heading', { name: 'New impact assessment' }).waitFor();

  const c1 = page.getByRole('group', { name: 'Change 1: Win a new customer or contract' });
  await c1.waitFor();
  await c1.getByLabel('Customer or contract').fill('Zenith Foods');
  await c1.getByLabel('Monthly sales at full speed').fill('60000');
  await page.getByRole('group', { name: 'People (HR)' }).getByRole('button', { name: 'Hire people' }).click();
  const c2 = page.getByRole('group', { name: 'Change 2: Hire people' });
  await c2.getByLabel('People hired').fill('2');
  await c2.getByLabel('Monthly cost per person').fill('25000');
  await page.getByRole('button', { name: 'Assess the impact' }).click();
  const summary = page.getByTestId('impact-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /^These 2 changes together leave net profit/);
  const first = page.getByRole('region', { name: 'Change 1: New customer: Zenith Foods' });
  // Cost of sales 1,20,000 on revenue 4,00,000 over the 6 baseline months: 30%.
  assert.match(await first.innerText(), /Cost of sales follows at 30\.00% of that revenue/);
  assert.match(await first.getByRole('table').innerText(), /Revenue\s+₹?[\s\S]*Receivables at the end/);
  assert.match(await page.getByRole('region', { name: 'Change 2: Hire 2 people' }).innerText(), /Payroll/);

  // Save it, then add equipment from operations.
  await page.getByLabel('Name').fill('Zenith contract');
  await page.getByRole('button', { name: 'Save assessment' }).click();
  await page.waitForURL(/\/planning\/impact\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Zenith contract' }).waitFor();
  await page.getByTestId('impact-summary').waitFor();
  await page.getByRole('button', { name: 'Buy equipment or automation' }).click();
  const c3 = page.getByRole('group', { name: 'Change 3: Buy equipment or automation' });
  await c3.getByLabel('Equipment', { exact: true }).fill('a packing line');
  await c3.getByLabel('Cost', { exact: true }).fill('240000');
  await c3.getByLabel('Useful life in months').fill('0');
  await page.getByRole('button', { name: 'Assess the impact' }).click();
  await page.getByText('Change 3: Useful life in months must be a whole number from 1 to 1200').waitFor();
  await c3.getByLabel('Useful life in months').fill('48');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Saved.').waitFor();
  const areas = page.getByRole('table', { name: 'By business area' });
  await areas.waitFor();
  const text = await areas.innerText();
  for (const a of ['Sales', 'People (HR)', 'Operations', 'Interaction', 'All changes together']) assert.match(text, new RegExp(a.replace(/[()]/g, '\\$&')));
  assert.match(await page.getByRole('region', { name: 'Change 3: Buy a packing line' }).innerText(), /Spent on equipment[\s\S]*Depreciation|Depreciation[\s\S]*Spent on equipment/);
  assert.equal(await page.getByRole('table', { name: 'Month by month' }).getByRole('row').count(), 13);

  // Into the digital twin.
  await page.getByRole('button', { name: 'Open as a twin scenario' }).click();
  await page.waitForURL(/\/planning\/twin\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Zenith contract (BI-0001)' }).waitFor();

  // Back to the list, then delete.
  await page.goto(`${WEB}/orgs/${orgId}/planning/impact`);
  const saved = page.getByRole('table', { name: 'Saved assessments' });
  await saved.waitFor();
  assert.match(await saved.innerText(), /Zenith contract\s+BI-0001/);
  await saved.getByRole('link', { name: 'Zenith contract' }).click();
  await page.getByRole('heading', { name: 'Zenith contract' }).waitFor();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(/\/planning\/impact$/);
  await page.getByText('No saved assessments yet').waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|status of 422/.test(e)), []);
});
