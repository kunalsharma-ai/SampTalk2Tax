/**
 * Browser end-to-end test for vendor onboarding (AP-002): the owner switches vendor onboarding on
 * from Purchases, a new vendor starts onboarding on their own, their bill and a payment to them are
 * refused, bank details are entered and verified, the checklist is worked through on the vendor's
 * page (files attached, payment terms proposed, no credit limit offered), submitted and approved,
 * which sets the payment terms, and the bill then posts and the vendor can be paid.
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

test('a new vendor is onboarded and approved before their bills post or they are paid', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Vendor Onboarding Owner');
  await page.getByLabel('Email').fill(`e2e-vendor-onboarding-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Vendor Onboarding Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));

  // Switch vendor onboarding on with the default checklist (customer onboarding stays off).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Vendor onboarding' }).click();
  const card = page.locator('[aria-label="Onboarding checklist"]');
  await card.getByLabel('Checklist item 3').waitFor();
  assert.equal(await card.getByLabel('Checklist item 2').inputValue(), 'Cancelled cheque or bank letter for the account to pay');
  await card.getByRole('button', { name: 'Remove' }).nth(2).click();
  await card.getByLabel('Onboard every new vendor before posting their bills or paying them').check();
  await card.getByRole('button', { name: 'Save checklist' }).click();
  await card.getByRole('status').getByText('Saved').waitFor();
  await page.getByText('Required for new vendors').waitFor();
  assert.equal((await call(`${B}/sales/onboarding-settings`)).body.required, false);

  // A new vendor starts onboarding on their own; their bill and a payment to them are refused.
  const vendor = (await call(`${B}/contacts`, { name: 'Shree Steel Suppliers', isVendor: true })).body;
  const bill = (await call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: T, dueDate: T, reference: 'SSS/101', lines: [{ accountId: acc['5000'] ?? acc['6000'], description: 'Steel', quantity: '1', unitPrice: '10000' }] })).body;
  const refused = await call(`${B}/purchases/documents/${bill.id}/post`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'ONBOARDING_INCOMPLETE');
  const pay = await call(`${B}/purchases/payments`, { contactId: vendor.id, date: T, bankAccountId: acc['1120'], amount: '500' });
  assert.equal(pay.status, 409);
  await call(`${B}/contacts/${vendor.id}`, { email: 'accounts@shreesteel.test', address: 'Chakan MIDC, Pune', pincode: '410501', pan: 'AAPFU0939F' }, 'PATCH');
  assert.equal((await call(`${B}/contacts/${vendor.id}/bank-details`, { accountName: 'Shree Steel Suppliers', accountNumber: '123456789012', ifsc: 'SBIN0000001' }, 'PUT')).status, 200);

  await page.goto(`${O}/purchases/vendors/${vendor.id}`);
  const panel = page.locator('[aria-label="Vendor onboarding"]');
  await panel.getByText('In progress').waitFor();
  assert.equal(await panel.getByLabel(/Credit limit/).count(), 0);
  assert.match(await panel.innerText(), /Bank details entered and verified/);
  const verify = await call(`${B}/contacts/${vendor.id}/bank-details/verify`, { note: 'Called the vendor on the number in the PO' });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  for (const [i, label] of ['GST certificate or PAN card', 'Cancelled cheque or bank letter for the account to pay'].entries()) {
    const chooser = page.waitForEvent('filechooser');
    await panel.getByRole('listitem').filter({ hasText: label }).getByRole('button', { name: 'Attach file' }).click();
    await (await chooser).setFiles({ name: `vendor-doc-${i}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% e2e vendor ${i}\n`) });
    await panel.getByRole('link', { name: `vendor-doc-${i}.pdf` }).waitFor();
  }
  await panel.getByLabel('Payment terms (days)').fill('45');
  await panel.getByRole('button', { name: 'Save terms' }).click();
  await panel.getByText('100% done').waitFor();
  await panel.getByRole('button', { name: 'Submit for approval' }).click();
  await panel.getByText('Waiting for approval').first().waitFor();

  // The only approver may decide alone; approval sets the payment terms.
  await panel.getByRole('button', { name: 'Approve' }).click();
  await panel.getByRole('status').getByText(/Approved by Vendor Onboarding Owner/).waitFor();
  const contact = (await call(`${B}/contacts/${vendor.id}`)).body;
  assert.equal(contact.paymentTermsDays, 45);
  assert.equal(contact.creditLimit ?? null, null);
  assert.equal((await call(`${B}/purchases/documents/${bill.id}/post`, {})).status, 200);
  assert.equal((await call(`${B}/purchases/payments`, { contactId: vendor.id, date: T, bankAccountId: acc['1120'], amount: '500' })).status, 201);

  await page.goto(`${O}/purchases/onboarding`);
  await page.getByRole('row', { name: /Shree Steel Suppliers/ }).getByText('Approved').waitFor();
  assert.equal(await page.getByRole('columnheader', { name: 'Credit limit' }).count(), 0);
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
