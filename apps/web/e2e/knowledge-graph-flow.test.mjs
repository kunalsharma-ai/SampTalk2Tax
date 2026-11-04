/**
 * Browser end-to-end test for the relationship explorer and figure tracing: an owner finds a
 * customer, sees its invoice and the receipt that settled it with the reason for each connection,
 * walks from the customer to the invoice, and then traces a profit-and-loss figure to the general
 * ledger, to the invoice that created the line and back into the explorer.
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
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
});

test('an owner explores how a customer, its invoice and receipt connect, and traces a figure to its source', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Gita Graph');
  await page.getByLabel('Email').fill(`e2e-graph-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Graph Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const acme = await call(`${base}/contacts`, { name: 'Acme Graph Retail', isCustomer: true });
  assert.equal(acme.status, 201);
  const inv = await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: acme.body.id, issueDate: T, dueDate: T, post: true, lines: [{ accountId: acc['4100'], description: 'Design work', quantity: '1', unitPrice: '75000.00' }] });
  assert.equal(inv.status, 201);
  const rec = await call(`${base}/sales/payments`, { contactId: acme.body.id, date: T, bankAccountId: acc['1120'], amount: '30000.00', allocations: [{ documentId: inv.body.id, amount: '30000.00' }], post: true });
  assert.equal(rec.status, 201);

  // Find the customer and see why each record is connected.
  await page.getByRole('link', { name: 'Relationship explorer' }).click();
  await page.getByRole('heading', { name: 'Relationship explorer' }).waitFor();
  await page.getByLabel('Find a record').fill('acme graph');
  const results = page.getByRole('list', { name: 'Search results' });
  await results.getByRole('button', { name: /^Acme Graph Retail/ }).click();
  await page.waitForURL(/\/graph\?type=CONTACT&id=/);
  assert.equal(await page.getByTestId('graph-centre').textContent(), 'Acme Graph Retail');
  const invoices = page.getByRole('list', { name: 'Issued to / invoices' });
  await invoices.getByText(`Invoice ${inv.body.number} for ₹75,000.00 was issued to Acme Graph Retail.`).waitFor();
  await page.getByRole('list', { name: 'Payments received' }).getByText(new RegExp(`Acme Graph Retail paid ₹30,000.00 \\(${rec.body.number}\\)`)).waitFor();

  // Walk to the invoice.
  await invoices.getByRole('link', { name: `Explore connections of ${inv.body.number}` }).click();
  await page.waitForURL(/\/graph\?type=DOCUMENT&id=/);
  assert.equal(await page.getByTestId('graph-centre').textContent(), inv.body.number);
  await page.getByRole('list', { name: 'Settled by' }).getByText(`${rec.body.number} settled ₹30,000.00 of Invoice ${inv.body.number}`, { exact: false }).waitFor();
  await page.getByRole('list', { name: 'Booked to accounts' }).getByText('₹75,000.00 of its lines, before tax, is income in 4100 Sales Revenue.').waitFor();
  await page.getByRole('link', { name: 'Open record' }).click();
  await page.waitForURL(new RegExp(`/sales/invoices/${inv.body.id}$`));

  // Trace a profit-and-loss figure to the ledger line and the invoice that created it.
  await page.goto(`${WEB}/orgs/${orgId}/reports/income-statement`);
  await page.getByRole('link', { name: 'Sales Revenue' }).click();
  await page.waitForURL(/\/reports\/general-ledger\?accountId=.*&from=\d{4}-\d{2}-\d{2}&to=/);
  const row = page.getByRole('row').filter({ hasText: inv.body.number });
  await row.getByText('posts').waitFor();
  await row.getByRole('link', { name: inv.body.number }).waitFor();
  await row.getByRole('link', { name: /^Connections of JE-/ }).click();
  await page.waitForURL(/\/graph\?type=DOCUMENT&id=/);
  assert.equal(await page.getByTestId('graph-centre').textContent(), inv.body.number);

  // A manual journal says so, and its connections start from the journal itself.
  const j = await call(`${base}/journals`, { date: T, memo: 'Graph e2e manual', post: true, lines: [{ accountId: acc['1120'], debit: '500.00' }, { accountId: acc['4100'], credit: '500.00' }] });
  assert.equal(j.status, 201);
  await page.goto(`${WEB}/orgs/${orgId}/reports/general-ledger?accountId=${acc['4100']}&to=${T}`);
  const manual = page.getByRole('row').filter({ hasText: 'Graph e2e manual' });
  await manual.getByText('Manual journal').waitFor();
  await manual.getByRole('link', { name: /^Connections of JE-/ }).click();
  await page.waitForURL(/\/graph\?type=JOURNAL&id=/);
  await page.getByRole('list', { name: 'Credits' }).getByText('Credits 4100 Sales Revenue with ₹500.00.').waitFor();

  assert.deepEqual(consoleErrors, []);
});
