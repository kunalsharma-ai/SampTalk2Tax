/**
 * Browser end-to-end test for invoice disputes (AR-025): from a posted invoice, Raise dispute… opens
 * the dispute dialog; the dispute is raised for part of the invoice; the invoice shows it as
 * disputed; a note and a change of amount go into the history; it is resolved with the customer's
 * credit note; the invoice no longer shows it and the list counts it as resolved.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
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

test('a customer disputes part of an invoice, the dispute is worked and settled by a credit note', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dispute Owner');
  await page.getByLabel('Email').fill(`e2e-disputes-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Disputes Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Banyan Retail', isCustomer: true })).body;
  const doc = async (kind, amount) => (await call(`${B}/sales/documents`, { kind, contactId: customer.id, issueDate: addDays(T, -20), dueDate: addDays(T, -5), post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] })).body;
  const inv = await doc('INVOICE', '10000');

  // Raise it from the invoice.
  await page.goto(`${O}/sales/invoices/${inv.id}`);
  await page.getByRole('link', { name: 'Raise dispute…' }).click();
  await page.waitForURL(/disputes\?raise=/);
  const dialog = page.getByRole('dialog', { name: `Raise a dispute on ${inv.number}` });
  await dialog.waitFor();
  await dialog.getByLabel('Reason').selectOption('PRICE');
  await dialog.getByLabel('What the customer disputes').fill('Billed at 1,000 a unit; the order says 750');
  await dialog.getByLabel(/^Amount in dispute/).fill('2500');
  await dialog.getByLabel('Owner').selectOption({ label: 'Dispute Owner' });
  await dialog.getByLabel('Settle by').fill(addDays(T, 7));
  await dialog.getByRole('button', { name: 'Raise dispute' }).click();
  await page.getByRole('heading', { name: 'Dispute DS-0001' }).waitFor();
  const history = page.getByRole('list', { name: 'Dispute history' });
  await history.getByText(/raised the dispute: Billed at 1,000 a unit/).waitFor();

  // The invoice shows it, and offers no second dispute.
  await page.goto(`${O}/sales/invoices/${inv.id}`);
  await page.getByText('Disputed: DS-0001').waitFor();
  assert.equal(await page.getByRole('link', { name: 'Raise dispute…' }).count(), 0);
  await page.getByRole('link', { name: 'Open the dispute' }).click();
  await page.getByRole('heading', { name: 'Dispute DS-0001' }).waitFor();

  // A note, then a change of amount; both are in the history.
  await page.getByLabel('Note').fill('Called Ravi; he will send the purchase order.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await history.getByText(/noted: Called Ravi/).waitFor();
  await page.getByRole('button', { name: 'Change…' }).click();
  const change = page.getByRole('dialog', { name: 'Change DS-0001' });
  await change.getByLabel(/^Amount in dispute/).fill('3000');
  await change.getByRole('button', { name: 'Save changes' }).click();
  await change.waitFor({ state: 'hidden' });
  await history.getByText(/changed amount from 2500\.00 to 3000\.00/).waitFor();

  // Settled with a credit note.
  const cn = await doc('CREDIT_NOTE', '3000');
  await page.reload();
  await page.getByRole('button', { name: 'Resolve…' }).click();
  const resolve = page.getByRole('dialog', { name: 'Resolve DS-0001' });
  assert.equal(await resolve.getByLabel('Outcome').inputValue(), 'CREDIT_NOTE');
  assert.equal(await resolve.locator('select').nth(1).inputValue(), cn.id);
  await resolve.getByLabel('How it was settled').fill('Agreed the rate of 700 a unit');
  await resolve.getByRole('button', { name: 'Resolve dispute' }).click();
  await page.getByText(/Resolved on .*: Credit note issued/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Resolve…' }).count(), 0);

  // Gone from the invoice; counted on the list.
  await page.goto(`${O}/sales/invoices/${inv.id}`);
  await page.getByRole('link', { name: 'Raise dispute…' }).waitFor();
  assert.equal(await page.getByText('Disputed: DS-0001').count(), 0);
  await page.goto(`${O}/sales/disputes`);
  await page.getByText('No open disputes').waitFor();
  await page.getByLabel('Show').selectOption('resolved');
  await page.getByRole('table', { name: 'Disputes' }).getByRole('row', { name: /DS-0001.*Banyan Retail.*Credit note issued/ }).waitFor();
  await page.getByText(/1 resolved · 1 by credit note/).waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
