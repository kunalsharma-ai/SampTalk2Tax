/**
 * Browser end-to-end test for pro forma invoices (AR-008): from a sent quotation, Make pro forma
 * invoice… fills the form; the draft is saved as PF-0001, issued, printed with the invoice template
 * as a pro forma (not a tax invoice), and turned into a draft tax invoice with the same lines.
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

test('a quotation becomes a pro forma invoice, is issued and printed, then becomes a tax invoice', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Pro Forma Owner');
  await page.getByLabel('Email').fill(`e2e-pro-forma-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Pro Forma Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Banyan Retail', isCustomer: true })).body;
  const quote = (await call(`${B}/sales/quotes`, { contactId: customer.id, issueDate: T, validUntil: addDays(T, 30), terms: '50% advance', lines: [{ accountId: acc['4100'], description: 'Steel racks', quantity: '4', unitPrice: '12500' }] })).body;
  assert.equal((await call(`${B}/sales/quotes/${quote.id}/send`, {})).status, 200);

  // From the quotation.
  await page.goto(`${O}/sales/quotes/${quote.id}`);
  await page.getByRole('link', { name: 'Make pro forma invoice…' }).click();
  await page.getByRole('heading', { name: 'New pro forma invoice' }).waitFor();
  await page.getByText(`Filled from quotation ${quote.reference}`).waitFor();
  await page.getByLabel('Customer', { exact: true }).locator('option', { hasText: 'Banyan Retail' }).waitFor({ state: 'attached' });
  assert.equal(await page.getByLabel('Customer', { exact: true }).inputValue(), customer.id);
  assert.equal(await page.getByLabel('Terms').inputValue(), '50% advance');
  await page.getByLabel('Valid until').fill(addDays(T, 10));
  await page.getByRole('button', { name: 'Save draft pro forma invoice' }).click();
  await page.getByRole('heading', { name: 'Pro forma invoice PF-0001' }).waitFor();
  await page.getByRole('link', { name: quote.reference }).waitFor();

  // Issue it; it can no longer be edited.
  await page.getByRole('button', { name: 'Issue', exact: true }).click();
  await page.getByRole('button', { name: 'Make tax invoice…' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Edit' }).count(), 0);

  // Printed with the invoice template, as a pro forma.
  await page.getByRole('link', { name: 'Print or PDF' }).click();
  const frame = page.frameLocator('iframe[title^="Pro forma invoice"]');
  await frame.getByRole('heading', { name: 'Pro forma invoice' }).waitFor();
  await frame.getByText('Not a tax invoice').waitFor();
  await frame.getByText('Valid until').waitFor();
  await page.getByRole('link', { name: 'Back to the pro forma invoice' }).click();

  // The tax invoice.
  await page.getByRole('button', { name: 'Make tax invoice…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Make a tax invoice from PF-0001' });
  await dlg.getByRole('button', { name: 'Make draft invoice' }).click();
  await page.waitForURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  await page.getByText('Reference PF-0001.').waitFor();
  await page.getByText('Steel racks').waitFor();
  await page.goto(`${O}/sales/pro-formas`);
  await page.getByLabel('Show').selectOption('invoiced');
  await page.getByRole('table', { name: 'Pro forma invoices' }).getByRole('row', { name: /PF-0001.*Banyan Retail.*Invoiced/ }).waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
