/**
 * Browser end-to-end test for automated exception investigation (AP-035): an order for cartons and
 * film, part received and billed; a draft bill for cartons not received yet at a price the vendor
 * charged before, plus freight, and a draft bill that repeats the film. Bill exceptions names the
 * likely cause and next step of each difference; once the cartons arrive an approver accepts the
 * price rise and freight there, and only the duplicate is left.
 * Real Next.js app → real API → real MongoDB.
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

test('bills held by order differences are investigated, and confirmed differences accepted', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Ishaan Invoices');
  await page.getByLabel('Email').fill(`e2e-billexc-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Bill Exceptions Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const fy = await must(call(`${B}/periods`));
  if (!fy.some((p) => p.startDate <= addDays(T, -10))) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(fy[0].startDate.slice(0, 4)) - 1 });
  const vendor = (await must(call(`${B}/contacts`, { name: 'Kestrel Packaging', isVendor: true }))).id;
  const P = `${B}/purchases/orders`;
  let po = await must(call(P, { contactId: vendor, orderDate: addDays(T, -10), lines: [{ accountId: acc('6600'), description: 'Packing cartons', quantity: '100', unitPrice: '40' }, { accountId: acc('6600'), description: 'Stretch film rolls', quantity: '10', unitPrice: '250' }] }));
  po = await must(call(`${P}/${po.id}/issue`, {}));
  po = (await must(call(`${P}/${po.id}/receipts`, { receiptDate: addDays(T, -6), lines: [{ orderLineId: po.lines[0].id, quantity: '60' }, { orderLineId: po.lines[1].id, quantity: '10' }] }))).order;
  const first = await must(call(`${P}/${po.id}/bill`, { issueDate: addDays(T, -5), reference: 'KP/INV/881' }));
  await must(call(`${B}/purchases/documents/${first.documentId}/post`, {}));
  const doc = (body) => must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor, ...body }));
  const priceBill = await doc({ issueDate: addDays(T, -3), reference: 'KP/INV/890', post: true, lines: [{ accountId: acc('6600'), description: 'Packing cartons', quantity: '20', unitPrice: '44' }] });
  await doc({ issueDate: addDays(T, -2), reference: 'KP/INV/902', purchaseOrderId: po.id, lines: [{ accountId: acc('6600'), description: 'Packing cartons', quantity: '30', unitPrice: '44', purchaseOrderLineId: po.lines[0].id }, { accountId: acc('6600'), description: 'Freight', quantity: '1', unitPrice: '500' }] });
  await doc({ issueDate: addDays(T, -1), reference: 'KP/INV/905', purchaseOrderId: po.id, lines: [{ accountId: acc('6600'), description: 'Stretch film rolls', quantity: '10', unitPrice: '250', purchaseOrderLineId: po.lines[1].id }] });
  consoleErrors.length = 0;

  await page.goto(`${base}/purchases/bill-exceptions`);
  const list = page.getByRole('list', { name: 'Bills held by order differences' });
  await list.waitFor();
  const bills = list.locator(':scope > li');
  await bills.first().getByText('Next: Check for a duplicate and delete it').waitFor();
  assert.equal(await bills.count(), 2);
  const [dup, cartons] = await bills.allInnerTexts();
  assert.match(dup, /Draft bill KP\/INV\/905[\s\S]*Kestrel Packaging[\s\S]*Line 1: May repeat an earlier bill[\s\S]*bills the same 10 at ₹250\.00 on order line 2/);
  assert.match(cartons, /Next: Record the goods received, then post[\s\S]*At stake ₹1,820\.00[\s\S]*Goods not received yet[\s\S]*40 more are still due[\s\S]*Vendor's price has gone up[\s\S]*Extra charge not on the order/);
  assert.ok(cartons.includes(`see ${priceBill.number}`));
  await page.getByText('₹4,320.00').waitFor();
  assert.equal(await bills.nth(1).getByRole('button', { name: 'Accept differences' }).count(), 0);

  // The cartons arrive: only the price rise and the freight are left, which the owner accepts.
  await must(call(`${P}/${po.id}/receipts`, { receiptDate: T, lines: [{ orderLineId: po.lines[0].id, quantity: '30' }] }));
  await page.reload();
  const ready = bills.filter({ hasText: 'KP/INV/902' });
  await ready.getByText('Next: Confirm the new price, then accept it').waitFor();
  await ready.getByLabel('Why accept Draft bill KP/INV/902').fill('New carton price agreed with Kestrel; freight as quoted');
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bill-exceptions.png`, fullPage: true });
  await ready.getByRole('button', { name: 'Accept differences' }).click();
  await ready.waitFor({ state: 'detached' });
  assert.equal(await bills.count(), 1);
  assert.deepEqual(consoleErrors, []);
});
