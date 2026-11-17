/**
 * Browser end-to-end test for purchase orders, goods receipts and three-way matching (AP-015/016/017):
 * a purchase order is drafted and issued, goods received are recorded, a bill is made from what was
 * received and matches; a second bill that bills more than received at a higher price is refused at
 * posting until the differences are accepted with a reason, then posts.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page;
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

test('an order is issued, received and billed; a bill that does not match posts only once accepted', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Purchase Owner');
  await page.getByLabel('Email').fill(`e2e-po-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Purchase Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = (await call(`${B}/contacts`, { name: 'Kestrel Packaging', isVendor: true })).body;

  // Draft the order in the form and issue it.
  await page.goto(`${O}/purchases/orders`);
  await page.getByRole('link', { name: 'New purchase order' }).click();
  await page.getByLabel('Vendor', { exact: true }).locator('option', { hasText: 'Kestrel Packaging' }).waitFor({ state: 'attached' });
  await page.getByLabel('Vendor', { exact: true }).selectOption(vendor.id);
  await page.getByLabel('Account for line 1').locator(`option[value="${acc['6600']}"]`).waitFor({ state: 'attached' });
  await page.getByLabel('Account for line 1').selectOption(acc['6600']);
  await page.getByLabel('Description for line 1').fill('Packing cartons');
  await page.getByLabel('Quantity for line 1').fill('100');
  await page.getByLabel('Unit price for line 1').fill('40');
  await page.getByLabel('Price tolerance (%)').fill('2');
  await page.getByRole('button', { name: 'Save draft order' }).click();
  await page.getByRole('heading', { name: 'Purchase order PO-0001' }).waitFor();
  await page.getByRole('button', { name: 'Issue to vendor' }).click();
  await page.getByRole('button', { name: 'Record goods received…' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Edit' }).count(), 0);

  // Sixty cartons arrive.
  await page.getByRole('button', { name: 'Record goods received…' }).click();
  await page.getByLabel('Delivery note or challan').fill('DC-501');
  await page.getByLabel('Accepted on line 1').fill('60');
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await page.getByRole('cell', { name: 'GRN-0001' }).waitFor();
  await page.getByText('Partly received').first().waitFor();

  // The bill for what arrived matches and posts.
  await page.getByRole('button', { name: 'Make bill…' }).click();
  await page.getByLabel('Vendor invoice number').fill('KP/INV/881');
  await page.getByRole('button', { name: 'Make draft bill' }).click();
  await page.waitForURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Purchase order match' }).waitFor();
  await page.getByText('Matches the order').waitFor();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText('BILL-', { exact: false }).first().waitFor();

  // A second bill from the vendor: 30 more cartons (none received) at 45.
  const order = (await call(`${B}/purchases/orders`)).body.orders[0];
  const detail = (await call(`${B}/purchases/orders/${order.id}`)).body;
  const second = (await call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: T, reference: 'KP/INV/902', purchaseOrderId: order.id, lines: [{ accountId: acc['6600'], description: 'Packing cartons', quantity: '30', unitPrice: '45', purchaseOrderLineId: detail.lines[0].id }] })).body;
  await page.goto(`${O}/purchases/bills/${second.id}`);
  await page.getByText('Does not match').waitFor();
  await page.getByText('price 45 is above the order price 40').waitFor();
  await page.getByText('billing 90 in all against 60 received').waitFor();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText(/This bill does not match PO-0001/).first().waitFor();

  // The owner decides approvals: accept with a reason, then it posts.
  await page.getByRole('button', { name: 'Accept differences…' }).click();
  await page.getByLabel('Why they are accepted').fill('Price rise agreed; 30 cartons arrive tomorrow');
  await page.getByRole('button', { name: 'Accept differences', exact: true }).click();
  await page.getByText('Differences accepted', { exact: true }).waitFor();
  await page.getByText('Price rise agreed; 30 cartons arrive tomorrow').waitFor();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText('BILL-000002').first().waitFor();
  const posted = (await call(`${B}/purchases/documents/${second.id}`)).body;
  assert.equal(posted.status, 'POSTED');

  // The order shows both bills and what is left.
  await page.goto(`${O}/purchases/orders/${order.id}`);
  await page.getByText('KP/INV/902').waitFor();
  await page.getByText('Differences accepted').waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
