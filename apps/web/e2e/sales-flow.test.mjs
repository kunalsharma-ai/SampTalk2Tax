/**
 * Browser end-to-end test for sales and purchases: real Next.js app → real API → real PostgreSQL.
 * Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, base;
const consoleErrors = [];
function dropExpectedResourceErrors(fromIndex) {
  for (let i = consoleErrors.length - 1; i >= fromIndex; i--) {
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(consoleErrors[i])) consoleErrors.splice(i, 1);
  }
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => browser?.close());

test('a new organisation is set up', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Sales Owner');
  await page.getByLabel('Email').fill(`e2e-sales-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Sales Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  base = page.url();
});

test('a tax rate is added and posts to the template tax accounts', async () => {
  await page.goto(`${base}/settings/tax-rates`);
  await page.getByRole('button', { name: 'New tax rate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Standard 18%');
  await dialog.getByLabel('Rate (%)').fill('18');
  await dialog.getByRole('button', { name: 'Save tax rate' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('cell', { name: '2300 · Output Tax Payable' }).waitFor();
  await page.getByRole('cell', { name: '1450 · Input Tax Receivable' }).waitFor();
});

test('an invoice shows live totals, posts, and creates the customer on the way', async () => {
  await page.goto(`${base}/sales/invoices/new`);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Harbour Cafe');
  await dialog.getByLabel('Payment terms (days)').fill('15');
  await dialog.getByRole('button', { name: 'Save customer' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.notEqual(await page.locator('#doc-contact').inputValue(), '');
  await page.getByLabel('Account for line 1').selectOption({ label: '4100 · Sales Revenue' });
  await page.getByLabel('Description for line 1').fill('Coffee beans');
  await page.getByLabel('Quantity for line 1').fill('4');
  await page.getByLabel('Unit price for line 1').fill('2500');
  await page.getByLabel('Tax for line 1').selectOption({ label: 'Standard 18%' });
  await page.getByText('₹11,800.00').first().waitFor();
  // The control account is not offered on document lines.
  const options = await page.getByLabel('Account for line 1').locator('option').allTextContents();
  assert.ok(!options.some((o) => o.startsWith('1200')));
  await page.getByRole('button', { name: 'Post invoice' }).click();
  await page.waitForURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Invoice INV-000001' }).waitFor();
  await page.getByText('Awaiting payment').waitFor();
});

test('a part payment is recorded against the invoice', async () => {
  await page.getByRole('link', { name: 'Record a receipt' }).click();
  await page.waitForURL(/\/sales\/receipts\/new/);
  const amount = page.getByLabel('Amount (INR)');
  await amount.waitFor();
  await page.getByLabel('Allocate to INV-000001').waitFor();
  assert.equal(await amount.inputValue(), '11800.00');
  await amount.fill('5000');
  await page.getByRole('button', { name: 'Allocate oldest first' }).click();
  assert.equal(await page.getByLabel('Allocate to INV-000001').inputValue(), '5000.00');
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await page.waitForURL(/\/sales\/receipts\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Receipt RCPT-000001' }).waitFor();
  await page.getByRole('link', { name: 'Invoice INV-000001' }).click();
  await page.getByText('Part paid').waitFor();
  await page.getByText('₹6,800.00').first().waitFor();
});

test('the receivables ageing ties to the general ledger', async () => {
  await page.goto(`${base}/sales/ageing`);
  await page.getByText('Ties to the general ledger').waitFor();
  await page.getByRole('link', { name: 'Harbour Cafe' }).waitFor();
});

test('manual journals do not offer the receivables control account', async () => {
  await page.goto(`${base}/journals/new`);
  const options = await page.getByLabel('Account for line 1').locator('option').allTextContents();
  assert.ok(!options.some((o) => o.startsWith('1200') || o.startsWith('2100')));
});

test("a vendor's invoice number cannot be entered twice", async () => {
  const enterBill = async (first) => {
    await page.goto(`${base}/purchases/bills/new`);
    await page.locator('#doc-contact').waitFor();
    if (first) {
      await page.getByRole('button', { name: 'New', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name', { exact: true }).fill('Roastery Supplies');
      await dialog.getByRole('button', { name: 'Save vendor' }).click();
      await dialog.waitFor({ state: 'detached' });
    } else {
      await page.locator('#doc-contact option', { hasText: 'Roastery Supplies' }).waitFor({ state: 'attached' });
      await page.locator('#doc-contact').selectOption({ label: 'Roastery Supplies' });
    }
    await page.getByLabel("Vendor's invoice number").fill('RS-1001');
    await page.getByLabel('Account for line 1').selectOption({ label: '5000 · Cost of Sales' });
    await page.getByLabel('Unit price for line 1').fill('3000');
    await page.getByRole('button', { name: 'Post bill' }).click();
  };
  await enterBill(true);
  await page.waitForURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Bill BILL-000001' }).waitFor();
  const mark = consoleErrors.length;
  await enterBill(false);
  await page.getByText(/already entered as BILL-000001/).waitFor();
  dropExpectedResourceErrors(mark);
});

test('an invoice is voided only after its receipt is removed', async () => {
  await page.goto(`${base}/sales/invoices?view=open`);
  await page.getByRole('link', { name: 'INV-000001' }).click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByText('Awaiting payment').waitFor();
  await page.getByRole('button', { name: 'Void…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Raised against the wrong customer');
  await dialog.getByRole('button', { name: 'Void invoice' }).click();
  await page.getByText(/Voided on/).waitFor();
  await page.goto(`${base}/sales/ageing`);
  await page.getByText('Ties to the general ledger').waitFor();
});

test('no unexpected console errors were logged', () => {
  assert.deepEqual(consoleErrors.filter((e) => !/favicon/.test(e)), [], consoleErrors.join('\n'));
});
