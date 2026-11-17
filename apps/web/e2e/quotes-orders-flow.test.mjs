/**
 * Browser end-to-end test for quotations and sales orders: an owner makes a quotation from a deal,
 * sends it, revises the price, sends the revision (the first is superseded), records it accepted
 * (a sales order, and the deal won), bills part of the order into a draft invoice, and enters and
 * cancels a direct order. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, base, orgId;
const consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a quotation from a deal is sent, revised, accepted into an order, and part billed', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Quotes Owner');
  await page.getByLabel('Email').fill(`e2e-quotes-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Quotes Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  base = page.url();
  orgId = base.split('/orgs/')[1];

  const accounts = (await call(`/v1/orgs/${orgId}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  assert.equal((await call(`/v1/orgs/${orgId}/tax-rates`, { name: 'Standard 18%', rate: '18', salesAccountId: acc('2300'), purchaseAccountId: acc('1450') })).status, 201);
  const customer = (await call(`/v1/orgs/${orgId}/contacts`, { name: 'Nair Logistics', isCustomer: true })).body;
  const deal = (await call(`/v1/orgs/${orgId}/crm/deals`, { name: 'Annual bookkeeping', contactId: customer.id, amount: '480000', stage: 'PROPOSAL', expectedCloseDate: '2027-01-31' })).body;
  assert.ok(deal.id, JSON.stringify(deal));

  // From the deal: a new quotation with the customer and deal filled in.
  await page.goto(`${base}/sales/pipeline/${deal.id}`);
  await page.getByRole('heading', { name: 'Quotations, orders and contracts' }).waitFor();
  await page.getByRole('link', { name: 'New quotation' }).click();
  await page.getByRole('heading', { name: 'New quotation' }).waitFor();
  await page.getByLabel('Deal', { exact: true }).locator('option', { hasText: 'Annual bookkeeping' }).waitFor({ state: 'attached' });
  assert.equal(await page.getByLabel('Customer', { exact: true }).inputValue(), customer.id);
  assert.equal(await page.getByLabel('Deal', { exact: true }).inputValue(), deal.id);
  await page.getByLabel('Account for line 1').selectOption({ label: '4100 · Sales Revenue' });
  await page.getByLabel('Description for line 1').fill('Monthly bookkeeping');
  await page.getByLabel('Quantity for line 1').fill('12');
  await page.getByLabel('Unit price for line 1').fill('40000');
  await page.getByLabel('Tax for line 1').selectOption({ label: 'Standard 18%' });
  await page.getByLabel('Terms').fill('Billed monthly in advance.');
  await page.getByText('₹5,66,400.00').first().waitFor();
  await page.getByRole('button', { name: 'Save draft quotation' }).click();
  await page.getByRole('heading', { name: 'Quotation QT-0001' }).waitFor();
  await page.getByText('Billed monthly in advance.').waitFor();

  // Send, then revise the price; sending the revision supersedes the first.
  await page.getByRole('button', { name: 'Mark sent' }).click();
  await page.getByRole('button', { name: 'Revise' }).waitFor();
  await page.getByRole('button', { name: 'Edit' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Revise' }).click();
  await page.getByRole('heading', { name: 'Edit QT-0001-R2' }).waitFor();
  await page.getByLabel('Unit price for line 1').fill('38000');
  await page.getByText('₹5,38,080.00').first().waitFor();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('heading', { name: 'Quotation QT-0001-R2' }).waitFor();
  await page.getByRole('button', { name: 'Mark sent' }).click();
  const versions = page.getByRole('table', { name: 'Quotation versions' });
  await versions.getByRole('row', { name: /QT-0001 .*Superseded/ }).waitFor();

  // Accepted: a sales order with the customer's PO, and the deal won.
  await page.getByRole('button', { name: 'Accepted' }).click();
  await page.getByRole('dialog').getByLabel('Customer PO number').fill('PO-7781');
  await page.getByRole('dialog').getByRole('button', { name: 'Make the sales order' }).click();
  await page.getByRole('heading', { name: 'Sales order SO-0001' }).waitFor();
  await page.getByText('customer PO PO-7781').waitFor();
  await page.getByRole('link', { name: 'QT-0001-R2' }).waitFor();

  // Bill three months now.
  await page.getByRole('button', { name: 'Bill this order' }).click();
  const bill = page.getByRole('dialog');
  assert.equal(await bill.getByLabel('Bill now for line 1').inputValue(), '12');
  await bill.getByLabel('Bill now for line 1').fill('13');
  await bill.getByText('more than is left to bill').waitFor();
  await bill.getByLabel('Bill now for line 1').fill('3');
  await bill.getByRole('button', { name: 'Make draft invoice' }).click();
  await page.waitForURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Draft invoice' }).waitFor();
  await page.getByText('Reference SO-0001 / PO-7781').waitFor();
  await page.getByText('₹1,34,520.00').first().waitFor();

  await page.goto(`${base}/sales/orders/${(await call(`/v1/orgs/${orgId}/sales/orders`)).body.orders[0].id}`);
  await page.getByRole('heading', { name: 'Sales order SO-0001' }).waitFor();
  await page.getByText('Partly billed').first().waitFor();
  await page.getByRole('table', { name: 'Order invoices' }).getByText('#1 × 3').waitFor();
  await page.getByText('₹4,03,560.00').first().waitFor(); // nine months left, with tax

  // The deal is won and shows both documents.
  await page.goto(`${base}/sales/pipeline/${deal.id}`);
  await page.getByText('Won', { exact: true }).first().waitFor();
  const dealSales = page.getByRole('table', { name: 'Deal quotations and orders' });
  await dealSales.getByText('Order SO-0001').waitFor();
  await dealSales.getByText('Quotation QT-0001-R2').waitFor();

  // Lists: the open order to bill, and the quotation acceptance rate.
  await page.getByRole('link', { name: 'Sales orders', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Sales orders', exact: true }).waitFor();
  await page.getByRole('table', { name: 'Sales orders' }).getByText('PO-7781').waitFor();
  await page.getByRole('link', { name: 'Quotations', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Quotations', exact: true }).waitFor();
  await page.getByText('100%').first().waitFor();
});

test('a direct order is entered and cancelled while nothing is billed', async () => {
  await page.goto(`${base}/sales/orders`);
  await page.getByRole('link', { name: 'New sales order' }).click();
  await page.getByRole('heading', { name: 'New sales order' }).waitFor();
  await page.getByLabel('Customer', { exact: true }).locator('option', { hasText: 'Nair Logistics' }).waitFor({ state: 'attached' });
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Nair Logistics' });
  await page.getByLabel('Customer PO number').fill('PO-8000');
  await page.getByLabel('Account for line 1').selectOption({ label: '4100 · Sales Revenue' });
  await page.getByLabel('Description for line 1').fill('Year-end accounts');
  await page.getByLabel('Unit price for line 1').fill('25000');
  await page.getByRole('button', { name: 'Save order' }).click();
  await page.getByRole('heading', { name: 'Sales order SO-0002' }).waitFor();
  await page.getByText('Not billed').first().waitFor();
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('dialog').getByLabel('Why is it cancelled?').fill('Customer withdrew the order');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('alert').getByText('Customer withdrew the order').waitFor();
  await page.getByRole('button', { name: 'Bill this order' }).waitFor({ state: 'detached' });

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
