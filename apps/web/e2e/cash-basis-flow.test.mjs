/**
 * Browser end-to-end test for cash-basis profit and loss (GL-014): an invoice half paid and a
 * bill unpaid show in full on the accrual basis; switching to Cash shows only the money that
 * moved, with the accrual result beside it. Real Next.js app → real API → real MongoDB.
 * Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page, orgId;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function call(path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('profit and loss switches between accrual and cash', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Cash Basis Owner');
  await page.getByLabel('Email').fill(`e2e-cash-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Cash Basis Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();

  const base = `/v1/orgs/${orgId}`;
  const accounts = (await call(`${base}/accounts`)).body;
  const acc = Object.fromEntries((accounts.items ?? accounts).map((a) => [a.code, a.id]));
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const customer = (await call(`${base}/contacts`, { name: 'Synthetic Customer', isCustomer: true })).body.id;
  const vendor = (await call(`${base}/contacts`, { name: 'Synthetic Vendor', isVendor: true })).body.id;
  const inv = await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: today, dueDate: today, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '10000.00' }] });
  assert.equal(inv.status, 201);
  assert.equal((await call(`${base}/sales/payments`, { contactId: customer, date: today, bankAccountId: acc['1120'], amount: '4000.00', allocations: [{ documentId: inv.body.id, amount: '4000.00' }] })).status, 201);
  assert.equal((await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: today, dueDate: today, reference: 'SYN-1', post: true, lines: [{ accountId: acc['6400'], quantity: '1', unitPrice: '3000.00' }] })).status, 201);

  await page.goto(`${WEB}/orgs/${orgId}/reports/income-statement`);
  const card = page.getByRole('heading', { name: 'Income statement' });
  await card.waitFor();
  await page.getByRole('row', { name: /Net income/ }).getByText('₹7,000.00').waitFor();

  await page.getByLabel('Basis').selectOption('CASH');
  await page.getByText('Income statement (cash basis)').waitFor();
  await page.getByRole('row', { name: /Net income/ }).getByText('₹4,000.00').waitFor();
  const note = page.getByRole('note', { name: 'Accrual comparison' });
  await note.getByText('₹7,000.00').waitFor();
  await note.getByText('₹3,000.00').waitFor();
  await shot('01-profit-and-loss-cash-basis');
  assert.deepEqual(consoleErrors, []);
});
