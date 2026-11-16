/**
 * Browser end-to-end test for customer onboarding (AR-003): the owner switches onboarding on and
 * sets the checklist, a new customer starts onboarding on their own, an invoice to them is refused,
 * the checklist is worked through on the customer's page (file attached, item ticked, terms
 * proposed), submitted and approved, which sets the credit limit, and the invoice then posts.
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

test('a new customer is onboarded and approved before being invoiced', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Onboarding Owner');
  await page.getByLabel('Email').fill(`e2e-onboarding-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Onboarding Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));

  // The checklist: keep the KYC item, drop the rest, add a credit check; switch it on.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Customer onboarding' }).click();
  const card = page.locator('[aria-label="Onboarding checklist"]');
  await card.getByLabel('Checklist item 3').waitFor();
  await card.getByLabel('Checklist item 1').fill('KYC documents');
  await card.getByRole('button', { name: 'Remove' }).nth(2).click();
  await card.getByRole('button', { name: 'Remove' }).nth(1).click();
  await card.getByRole('button', { name: 'Add item' }).click();
  await card.getByLabel('Checklist item 2').fill('Two trade references called');
  await card.getByLabel('Onboard every new customer before invoicing them').check();
  await card.getByRole('button', { name: 'Save checklist' }).click();
  await card.getByRole('status').getByText('Saved').waitFor();
  await page.getByText('Required for new customers').waitFor();

  // A new customer starts onboarding on their own, and cannot be invoiced yet.
  const customer = (await call(`${B}/contacts`, { name: 'Bharat Engineering', isCustomer: true })).body;
  const d = (await call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, dueDate: T, lines: [{ accountId: acc['4100'], description: 'Setup', quantity: '1', unitPrice: '5000' }] })).body;
  const refused = await call(`${B}/sales/documents/${d.id}/post`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'ONBOARDING_INCOMPLETE');
  await call(`${B}/contacts/${customer.id}`, { email: 'accounts@bharat.test', address: 'MIDC Bhosari, Pune', pincode: '411026', pan: 'AAPFU0939F' }, 'PATCH');

  await page.goto(`${O}/sales/customers/${customer.id}`);
  const panel = page.locator('[aria-label="Customer onboarding"]');
  await panel.getByText('In progress').waitFor();
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('listitem').filter({ hasText: 'KYC documents' }).getByRole('button', { name: 'Attach file' }).click();
  await (await chooser).setFiles({ name: 'pan-card.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e\n') });
  await panel.getByRole('link', { name: 'pan-card.pdf' }).waitFor();
  await panel.getByRole('listitem').filter({ hasText: 'Two trade references called' }).getByRole('button', { name: 'Mark done' }).click();
  await panel.getByText(/Done by Onboarding Owner/).nth(1).waitFor();
  await panel.getByLabel(/Credit limit/).fill('150000');
  await panel.getByLabel('Payment terms (days)').fill('30');
  await panel.getByRole('button', { name: 'Save terms' }).click();
  await panel.getByText('100% done').waitFor();
  await panel.getByRole('button', { name: 'Submit for approval' }).click();
  await panel.getByText('Waiting for approval').first().waitFor();

  // The only approver may decide alone; approval sets the credit limit and terms.
  await panel.getByRole('button', { name: 'Approve' }).click();
  await panel.getByRole('status').getByText(/Approved by Onboarding Owner/).waitFor();
  assert.match(await panel.innerText(), /nobody else can approve/);
  await page.getByText(/30 day terms · credit limit ₹1,50,000\.00/).waitFor();
  assert.equal((await call(`${B}/sales/documents/${d.id}/post`, {})).status, 200);

  await page.goto(`${O}/sales/onboarding`);
  await page.getByRole('row', { name: /Bharat Engineering/ }).getByText('Approved').waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
