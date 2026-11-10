/**
 * Browser end-to-end test for vendor performance (AP-021): a vendor's order is received late with
 * goods rejected and billed above the order price, the vendor's page shows the scorecard and the
 * late delivery, a review is refused without a note at rating 2, added with one, then withdrawn by
 * its author, and Purchases → Vendor performance lists the vendor with its grade.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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

test('a vendor is scored from their deliveries, rejects, billing and reviews', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Performance Owner');
  await page.getByLabel('Email').fill(`e2e-vendor-perf-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Vendor Performance Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));

  // An order expected 10 days ago, delivered 6 days ago with 5 of 50 rejected, billed at 44 against 40.
  const vendor = (await call(`${B}/contacts`, { name: 'Deccan Fasteners', isVendor: true })).body;
  let po = (await call(`${B}/purchases/orders`, { contactId: vendor.id, orderDate: addDays(T, -20), expectedDate: addDays(T, -10), lines: [{ accountId: acc['6600'], description: 'Hex bolts M8 (box)', quantity: '50', unitPrice: '40' }] })).body;
  po = (await call(`${B}/purchases/orders/${po.id}/issue`, {})).body;
  assert.equal((await call(`${B}/purchases/orders/${po.id}/receipts`, { receiptDate: addDays(T, -6), lines: [{ orderLineId: po.lines[0].id, quantity: '50', rejected: '5' }] })).status, 201);
  const bill = (await call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: addDays(T, -5), reference: 'DF/19', purchaseOrderId: po.id, lines: [{ accountId: acc['6600'], description: 'Hex bolts M8 (box)', quantity: '50', unitPrice: '44', purchaseOrderLineId: po.lines[0].id }] })).body;
  assert.equal((await call(`${B}/purchases/bills/${bill.id}/match/accept`, { reason: 'New price list from this month' })).status, 200);
  assert.equal((await call(`${B}/purchases/documents/${bill.id}/post`, {})).status, 200);

  await page.goto(`${O}/purchases/vendors/${vendor.id}`);
  const card = page.locator('[aria-label="Vendor performance"]');
  await card.getByText('Grade D · 3.0').waitFor();
  await card.getByRole('row', { name: new RegExp(po.reference) }).getByText('Late').waitFor();
  assert.match(await card.innerText(), /9\.09%/);
  assert.match(await card.innerText(), /₹200\.00/);

  // A low rating needs a note; then it counts; then its author withdraws it.
  const form = card.locator('[aria-label="Add a review"]');
  await form.getByLabel('About').selectOption('Delivery');
  await form.getByLabel('Rating').selectOption('2');
  await form.getByLabel('Purchase order (optional)').selectOption(po.id);
  await form.getByRole('button', { name: 'Add review' }).click();
  await card.getByText('Say what went wrong when rating 1 or 2').waitFor();
  await form.getByLabel('Note').fill('Four days late and five boxes crushed');
  await form.getByRole('button', { name: 'Add review' }).click();
  await card.getByText('Four days late and five boxes crushed').waitFor();
  await card.getByText(/Team reviews 25\.0/).waitFor();
  await card.getByRole('button', { name: 'Withdraw' }).click();
  await card.getByLabel('Why withdraw it').fill('Rated the wrong vendor');
  await card.getByRole('button', { name: 'Withdraw review' }).click();
  await card.getByText(/Withdrawn by Performance Owner/).waitFor();
  assert.equal(await card.getByText(/Team reviews 25\.0/).count(), 0);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Vendor performance' }).click();
  const row = page.getByRole('row', { name: /Deccan Fasteners/ });
  await row.getByText('D', { exact: true }).waitFor();
  assert.match(await row.innerText(), /0\.0%/);
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
