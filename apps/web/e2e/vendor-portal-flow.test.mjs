/**
 * Browser end-to-end test for the vendor portal (AP-013): on a vendor's page a portal link is
 * made; the vendor opens it without a session, sees what they are owed, their bill and their
 * purchase order, and sends an invoice with its PDF; staff find it under Purchases → Vendor
 * invoices and record it against its bill; the vendor sees it recorded. Real Next.js app → real
 * API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
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

test('a vendor sees their account and sends an invoice that staff record', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Payables Owner');
  await page.getByLabel('Email').fill(`e2e-vendor-portal-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Vendor Portal Buyers');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const v = (await call(`${B}/contacts`, { isVendor: true, name: 'Sahyadri Cartons' })).body;
  const other = (await call(`${B}/contacts`, { isVendor: true, name: 'Konkan Films' })).body;
  const bill = (contactId, amount, reference, issueDate, post = true) => call(`${B}/purchases/documents`, { kind: 'BILL', contactId, issueDate, dueDate: addDays(issueDate, 30), reference, post, lines: [{ accountId: acc['6600'], description: 'Cartons', quantity: '1', unitPrice: amount }] });
  const b1 = (await bill(v.id, '30000.00', 'SC/2201', addDays(T, -40))).body;
  assert.equal((await bill(other.id, '9999.00', 'KF/1', T)).status, 201);
  assert.equal((await call(`${B}/purchases/payments`, { contactId: v.id, date: T, bankAccountId: acc['1120'], amount: '10000.00', reference: 'UTR 7781', allocations: [{ documentId: b1.id, amount: '10000.00' }] })).status, 201);
  const po = (await call(`${B}/purchases/orders`, { contactId: v.id, orderDate: addDays(T, -2), lines: [{ accountId: acc['6600'], description: 'Printed cartons', quantity: '500', unitPrice: '24' }] })).body;
  assert.equal((await call(`${B}/purchases/orders/${po.id}/issue`, {})).status, 200);

  // Staff make a link on the vendor's page.
  await page.goto(`${O}/purchases/vendors/${v.id}`);
  const card = page.locator('[aria-label="Vendor portal"]');
  await card.getByText('No portal links yet.').waitFor();
  await card.getByRole('button', { name: 'Make portal link' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Note').fill('Sent to their accounts desk');
  await dlg.getByRole('button', { name: 'Make link' }).click();
  const link = await dlg.getByLabel('Portal link').inputValue();
  assert.match(link, /\/vendor-portal\/t2tv_[A-Za-z0-9]{40}$/);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await card.getByText('Sent to their accounts desk').waitFor();

  // The vendor opens it with no session at all.
  const outside = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const vp = await outside.newPage();
  vp.on('console', (m) => m.type() === 'error' && consoleErrors.push(`portal: ${m.text()}`));
  await vp.goto(link);
  await vp.getByRole('heading', { name: 'E2E Vendor Portal Buyers' }).waitFor();
  assert.match(await vp.locator('[aria-label="What you are owed"]').innerText(), /Owed to you[\s\S]*20,000\.00[\s\S]*Due now[\s\S]*0\.00/);
  const bills = await vp.locator('[aria-label="Your bills"]').innerText();
  assert.match(bills, /SC\/2201[\s\S]*30,000\.00[\s\S]*20,000\.00[\s\S]*Part paid/);
  assert.doesNotMatch(bills, /9,999|Konkan/);
  await vp.locator('[aria-label="Payments made to you"]').getByText('UTR 7781').waitFor();
  assert.match(await vp.locator('[aria-label="Purchase orders"]').innerText(), new RegExp(`${po.reference}[\\s\\S]*12,000\\.00`));

  // The vendor sends an invoice with its PDF, quoting the order.
  const send = vp.locator('[aria-label="Send an invoice"]');
  await send.getByLabel('Your invoice number').fill('SC/2240');
  await send.getByLabel('Invoice date').fill(addDays(T, -1));
  await send.getByLabel('Total, with tax').fill('12000.00');
  await send.getByLabel('Purchase order').selectOption({ label: po.reference });
  await send.getByLabel('Invoice file').setInputFiles({ name: 'SC-2240.pdf', mimeType: 'application/pdf', buffer: PDF });
  await send.getByLabel('Note').fill('Cartons delivered to the Nashik store');
  await send.getByRole('button', { name: 'Send invoice' }).click();
  await send.getByText('Invoice SC/2240 was sent.', { exact: false }).waitFor();
  const sentRow = send.getByRole('row', { name: /SC\/2240/ });
  await sentRow.getByText('Received, being checked').waitFor();
  assert.match(await sentRow.innerText(), /SC-2240\.pdf/);
  // The same number again is refused.
  await send.getByLabel('Your invoice number').fill('sc 2240');
  await send.getByLabel('Total, with tax').fill('12000.00');
  await send.getByRole('button', { name: 'Send invoice' }).click();
  await send.getByText('You already sent invoice sc 2240; it is waiting to be checked').waitFor();

  // Staff find it under Purchases → Vendor invoices, record the bill, then record the invoice against it.
  const b2 = (await bill(v.id, '12000.00', 'SC-2240', addDays(T, -1), false)).body;
  await page.goto(`${O}/purchases/vendors`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Vendor invoices' }).click();
  await page.waitForURL(/\/purchases\/vendor-invoices$/);
  const list = page.locator('[aria-label="Invoices sent by vendors"]');
  const row = list.getByRole('row', { name: /SC\/2240/ });
  await row.getByText('To check').waitFor();
  assert.match(await row.innerText(), /Sahyadri Cartons[\s\S]*12,000\.00/);
  await row.getByRole('link', { name: 'SC-2240.pdf' }).waitFor();
  await row.getByRole('button', { name: 'Record' }).click();
  await dlg.getByLabel('Bill').waitFor();
  assert.equal(await dlg.getByLabel('Bill').inputValue(), b2.id);
  await dlg.getByRole('button', { name: 'Record' }).click();
  await dlg.waitFor({ state: 'detached' });
  await list.getByText('Nothing to check').waitFor();
  await list.getByLabel('Status').selectOption('RECORDED');
  await list.getByRole('row', { name: /SC\/2240/ }).getByText('Recorded', { exact: true }).waitFor();

  // The file is on the bill, and the vendor sees it recorded.
  await page.goto(`${O}/purchases/bills/${b2.id}`);
  await page.getByRole('link', { name: 'SC-2240.pdf' }).waitFor();
  await vp.reload();
  await vp.locator('[aria-label="Send an invoice"]').getByRole('row', { name: /SC\/2240/ }).getByText('Recorded', { exact: true }).waitFor();
  await outside.close();

  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
