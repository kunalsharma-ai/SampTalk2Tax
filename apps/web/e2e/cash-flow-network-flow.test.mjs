/**
 * Browser end-to-end test for the cash-flow network (DASH-024): an owner opens Reports →
 * Cash-flow network, sees cash coming in from customers and owners and going out to vendors and
 * payroll, picks out one group with the keyboard, plays the months and chooses this month from
 * the table. Real Next.js app → real API → real MongoDB.
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
// Today in India, the organisation's time zone; every movement is dated today.
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner watches where the cash came from and went', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Cash Network');
  await page.getByLabel('Email').fill(`e2e-cashnet-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Cash Network Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const customer = ok(await call(`${base}/contacts`, { name: 'Asha Traders', isCustomer: true }), 'customer').id;
  const vendor = ok(await call(`${base}/contacts`, { name: 'Granite Supplies', isVendor: true }), 'vendor').id;
  const inv = ok(
    await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: T, dueDate: T, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '80000.00' }] }),
    'invoice',
  );
  ok(
    await call(`${base}/sales/payments`, { contactId: customer, date: T, bankAccountId: acc['1120'], amount: '80000.00', allocations: [{ documentId: inv.id, amount: '80000.00' }], post: true }),
    'receipt',
  );
  const bill = ok(
    await call(`${base}/purchases/documents`, {
      kind: 'BILL',
      contactId: vendor,
      issueDate: T,
      dueDate: T,
      reference: 'G-1',
      post: true,
      lines: [{ accountId: acc['6100'], quantity: '1', unitPrice: '30000.00' }],
    }),
    'bill',
  );
  ok(
    await call(`${base}/purchases/payments`, { contactId: vendor, date: T, bankAccountId: acc['1120'], amount: '30000.00', allocations: [{ documentId: bill.id, amount: '30000.00' }], post: true }),
    'bill payment',
  );
  ok(
    await call(`${base}/journals`, {
      date: T,
      memo: 'Capital',
      post: true,
      lines: [
        { accountId: acc['1120'], debit: '200000.00' },
        { accountId: acc['3100'], credit: '200000.00' },
      ],
    }),
    'capital',
  );
  ok(
    await call(`${base}/journals`, {
      date: T,
      memo: 'Petty cash',
      post: true,
      lines: [
        { accountId: acc['1110'], debit: '10000.00' },
        { accountId: acc['1120'], credit: '10000.00' },
      ],
    }),
    'petty cash',
  );
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}`);
  await page.getByRole('link', { name: 'Cash-flow network' }).click();
  await page.getByRole('heading', { name: 'Cash-flow network', exact: true }).waitFor();
  const moving = page.getByRole('region', { name: 'Cash moving' });
  await moving.getByRole('img', { name: /^Cash coming in from the groups on the left/ }).waitFor();
  assert.equal(await page.getByTestId('cash-period').textContent(), 'All months');
  await moving.getByText('₹2,80,000.00', { exact: true }).waitFor();
  const flows = page.getByRole('region', { name: 'Cash flows' }).getByRole('table');
  assert.deepEqual(
    (await flows.locator('tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()),
    [
      'Owners 1120 · Operating Bank Account ₹2,00,000.00',
      'Customers and income 1120 · Operating Bank Account ₹80,000.00',
      '1120 · Operating Bank Account Vendors and spending ₹30,000.00',
      '1120 · Operating Bank Account 1110 · Cash on Hand ₹10,000.00',
    ],
  );
  if (SHOTS) await moving.screenshot({ path: `${SHOTS}/cash-flow-network.png` });

  // Pick out the customers with the keyboard: only their flow is listed.
  const customers = moving.getByRole('button', { name: /^Customers and income: / });
  await customers.focus();
  await page.keyboard.press('Enter');
  assert.equal(await customers.getAttribute('aria-pressed'), 'true');
  await page.getByRole('region', { name: 'Cash flows' }).getByText('for Customers and income', { exact: false }).waitFor();
  assert.equal(await flows.locator('tbody tr').count(), 1);
  await customers.click();
  assert.equal(await flows.locator('tbody tr').count(), 4);

  // Play the months, pause, then choose this month from the table.
  await moving.getByRole('button', { name: 'Play months' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="cash-period"]')?.textContent !== 'All months');
  await moving.getByRole('button', { name: 'Pause' }).click();
  const byMonth = page.getByRole('table', { name: 'Cash in and out by month' });
  await byMonth.getByRole('button', { name: label(T.slice(0, 7)), exact: true }).click();
  assert.equal(await page.getByTestId('cash-period').textContent(), label(T.slice(0, 7)));
  await moving.getByText('₹2,80,000.00', { exact: true }).waitFor();
  // An earlier month moved nothing.
  await byMonth.getByRole('button').first().click();
  await moving.getByText(/^No cash moved in /).waitFor();
  await moving.getByRole('button', { name: 'All months' }).click();
  assert.equal(await page.getByTestId('cash-period').textContent(), 'All months');

  assert.deepEqual(consoleErrors, []);
});
