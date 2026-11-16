/**
 * Browser end-to-end test for customer contracts: an owner sets up a monthly contract that started
 * two months ago from a deal, activates it (three periods billed into draft invoices, the deal
 * won), sees MRR and ARR, deletes one draft invoice and bills that period again, renews with a
 * price rise, pauses and resumes, and cancels another contract.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const months = (n) => {
  const [y, m, d] = T.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
const minusDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
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

test('a contract bills its due periods, renews with a price rise, and pauses', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Contracts Owner');
  await page.getByLabel('Email').fill(`e2e-contracts-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Contracts Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  base = page.url();
  orgId = base.split('/orgs/')[1];
  const accounts = (await call(`/v1/orgs/${orgId}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  assert.equal((await call(`/v1/orgs/${orgId}/tax-rates`, { name: 'Standard 18%', rate: '18', salesAccountId: acc('2300'), purchaseAccountId: acc('1450') })).status, 201);
  const customer = (await call(`/v1/orgs/${orgId}/contacts`, { name: 'Nair Logistics', isCustomer: true })).body;
  const deal = (await call(`/v1/orgs/${orgId}/crm/deals`, { name: 'Monthly books', contactId: customer.id, amount: '480000', stage: 'NEGOTIATION', expectedCloseDate: T })).body;

  // From the deal: a new contract with the customer and deal filled in.
  await page.goto(`${base}/sales/pipeline/${deal.id}`);
  await page.getByRole('link', { name: 'New contract' }).click();
  await page.getByRole('heading', { name: 'New contract' }).waitFor();
  await page.getByLabel('Deal', { exact: true }).locator('option', { hasText: 'Monthly books' }).waitFor({ state: 'attached' });
  assert.equal(await page.getByLabel('Customer', { exact: true }).inputValue(), customer.id);
  await page.getByLabel('Title').fill('Monthly bookkeeping and GST returns');
  await page.getByLabel('Start date').fill(months(-2));
  await page.getByLabel('End date', { exact: true }).fill(minusDay(months(10)));
  await page.getByLabel('Payment terms (days)').fill('10');
  await page.getByLabel('Account for line 1').selectOption({ label: '4100 · Sales Revenue' });
  await page.getByLabel('Description for line 1').fill('Bookkeeping');
  await page.getByLabel('Unit price for line 1').fill('40000');
  await page.getByLabel('Tax for line 1').selectOption({ label: 'Standard 18%' });
  await page.getByText('₹47,200.00').first().waitFor();
  await page.getByRole('button', { name: 'Save draft contract' }).click();
  await page.getByRole('heading', { name: 'CT-0001 Monthly bookkeeping and GST returns' }).waitFor();
  await page.getByRole('table', { name: 'Upcoming periods' }).waitFor();

  // Activate: the three periods to date become draft invoices.
  await page.getByRole('button', { name: 'Activate' }).click();
  const billed = page.getByRole('table', { name: 'Billed periods' });
  await billed.getByRole('row').nth(3).waitFor();
  assert.equal(await billed.getByRole('link', { name: 'Draft invoice' }).count(), 3);
  await page.getByRole('list', { name: 'Contract history' }).getByText(/Billed 3 periods/).waitFor();

  // One draft deleted; that period is billed again.
  await billed.getByRole('link', { name: 'Draft invoice' }).first().click();
  await page.getByRole('heading', { name: 'Draft invoice' }).waitFor();
  await page.getByText(/^Reference CT-0001 /).waitFor();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete draft' }).click();
  await page.waitForURL(/\/sales\/invoices$/);
  await page.goto(`${base}/sales/contracts`);
  await page.getByRole('link', { name: 'CT-0001' }).click();
  await billed.getByText('Invoice deleted').waitFor();
  await page.getByRole('button', { name: 'Bill again' }).click();
  await billed.getByText('Invoice deleted').waitFor({ state: 'detached' });

  // Renew for twelve months with a 5% rise.
  await page.getByRole('button', { name: 'Renew' }).click();
  await page.getByRole('dialog').getByLabel('Price change (%)').fill('5');
  await page.getByRole('dialog').getByRole('button', { name: 'Renew' }).click();
  await page.getByRole('list', { name: 'Contract history' }).getByText(/Renewed for 12 months/).waitFor();
  await page.getByText('₹49,560.00').first().waitFor();

  // MRR and ARR on the list; the deal is won.
  await page.getByRole('link', { name: 'Contracts', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Contracts', exact: true }).waitFor();
  await page.getByText('₹42,000.00').first().waitFor();
  await page.getByText('₹5,04,000.00').first().waitFor();
  await page.goto(`${base}/sales/pipeline/${deal.id}`);
  await page.getByRole('table', { name: 'Deal quotations and orders' }).getByText('Contract CT-0001').waitFor();
  await page.getByText('Won', { exact: true }).first().waitFor();

  // Pause and resume.
  await page.goto(`${base}/sales/contracts`);
  await page.getByRole('link', { name: 'CT-0001' }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByText('Periods that fall due while paused are skipped').waitFor();
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.getByRole('button', { name: 'Bill now' }).waitFor();
});

test('a rolling contract is cancelled with a reason', async () => {
  await page.goto(`${base}/sales/contracts/new`);
  await page.getByLabel('Customer', { exact: true }).locator('option', { hasText: 'Nair Logistics' }).waitFor({ state: 'attached' });
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Nair Logistics' });
  await page.getByLabel('Title').fill('Payroll processing');
  await page.getByLabel('Rolling (no end date)').check();
  await page.getByLabel('Billed').selectOption('QUARTERLY');
  await page.getByLabel('Account for line 1').selectOption({ label: '4100 · Sales Revenue' });
  await page.getByLabel('Unit price for line 1').fill('30000');
  await page.getByRole('button', { name: 'Save draft contract' }).click();
  await page.getByRole('heading', { name: 'CT-0002 Payroll processing' }).waitFor();
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByText('Rolling', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Cancel contract' }).click();
  await page.getByRole('dialog').getByLabel('Why is it cancelled?').fill('Customer moved payroll in-house');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel contract' }).click();
  await page.getByRole('alert').getByText('Customer moved payroll in-house').waitFor();
  await page.getByRole('button', { name: 'Bill now' }).waitFor({ state: 'detached' });

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
