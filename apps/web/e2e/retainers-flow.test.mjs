/**
 * Browser end-to-end test for retainers (AR-015): a new retainer for a customer, a receipt recorded
 * into it (posted as an ordinary receipt), two invoices paid from it oldest due first, the top-up
 * due once it falls below the minimum, and the receipt's allocations on the receipt page.
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

test('a retainer is funded, pays invoices and asks for a top-up', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Retainer Owner');
  await page.getByLabel('Email').fill(`e2e-retainers-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Retainers Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Mehta Exports', isCustomer: true })).body;
  const inv = async (amount, due) => {
    const d = (await call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, dueDate: due, lines: [{ accountId: acc['4100'], description: 'Advisory', quantity: '1', unitPrice: amount }] })).body;
    return (await call(`${B}/sales/documents/${d.id}/post`, {})).body;
  };
  const later = await inv('30000', addDays(T, 20));
  const sooner = await inv('25000', addDays(T, 5));

  await page.goto(`${O}/sales/retainers`);
  await page.getByRole('button', { name: 'New retainer' }).click();
  await page.getByLabel('Customer').locator('option', { hasText: 'Mehta Exports' }).waitFor({ state: 'attached' });
  await page.getByLabel('Customer').selectOption(customer.id);
  await page.getByLabel('Name').fill('Monthly advisory');
  await page.getByLabel('Agreed amount').fill('100000');
  await page.getByLabel('Top up below').fill('50000');
  await page.getByRole('button', { name: 'Save retainer' }).click();
  await page.getByRole('heading', { name: 'Retainer RT-0001' }).waitFor();
  await page.getByText('Top-up due', { exact: true }).first().waitFor();

  await page.getByRole('button', { name: 'Record receipt…' }).click();
  assert.equal(await page.getByLabel('Amount received').inputValue(), '100000.00');
  await page.getByRole('dialog').getByRole('button', { name: 'Record receipt' }).click();
  await page.getByRole('table', { name: 'Retainer receipts' }).waitFor();
  await page.getByRole('button', { name: 'Pay invoices…' }).waitFor();

  await page.getByRole('button', { name: 'Pay invoices…' }).click();
  assert.equal(await page.getByLabel(`Pay now for ${sooner.number}`).inputValue(), '25000.00');
  assert.equal(await page.getByLabel(`Pay now for ${later.number}`).inputValue(), '30000.00');
  await page.getByRole('button', { name: 'Pay from retainer' }).click();
  await page.getByRole('table', { name: 'Invoices paid from the retainer' }).getByText(sooner.number).waitFor();
  await page.getByText('This customer owes nothing now.').waitFor();
  await page.getByText(/Ask Mehta Exports for/).waitFor();
  const r = (await call(`${B}/sales/retainers?view=all`)).body.retainers[0];
  assert.equal(r.held, '45000.00');
  assert.equal(r.topUpDue, '55000.00');
  assert.equal((await call(`${B}/sales/documents/${sooner.id}`)).body.amountDue, '0.00');

  await page.goto(`${O}/sales/retainers`);
  await page.getByRole('table', { name: 'Retainers' }).getByRole('row', { name: /RT-0001.*Mehta Exports.*Top-up due/ }).waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
