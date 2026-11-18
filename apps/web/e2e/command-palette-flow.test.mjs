/**
 * Browser end-to-end test for global search (NAV-001): Ctrl+K opens the search, a page is found by
 * name and opened with the keyboard, and a customer and an invoice are found by name and number.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];

async function call(path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('Ctrl+K finds pages, records and actions and opens them', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Search Owner');
  await page.getByLabel('Email').fill(`e2e-search-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Search Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const accounts = (await call(`${base}/accounts`)).body;
  const sales = (accounts.items ?? accounts).find((a) => a.code === '4100').id;
  const customer = (await call(`${base}/contacts`, { name: 'Banyan Tree Traders', isCustomer: true })).body;
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const inv = (await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: today, post: true, lines: [{ accountId: sales, quantity: '1', unitPrice: '2500.00' }] })).body;

  // A page, by keyboard.
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search' });
  const box = dialog.getByRole('combobox', { name: 'Search pages and records' });
  await box.fill('bank acc');
  await dialog.getByRole('option', { name: /Bank accounts/ }).waitFor();
  assert.equal(await dialog.getByRole('option').first().getAttribute('aria-selected'), 'true');
  await box.press('Enter');
  await page.waitForURL(new RegExp(`/orgs/${orgId}/banking$`));

  // A customer by name, and an invoice by its number.
  await page.getByRole('button', { name: /^Search/ }).first().click();
  await box.fill('banyan');
  const hit = dialog.getByRole('option', { name: /^Banyan Tree Traders Contact/ });
  await hit.waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-search.png` });
  await hit.click();
  await page.waitForURL(new RegExp(`/sales/customers/${customer.id}$`));

  await page.keyboard.press('Control+k');
  await box.fill(inv.number);
  await dialog.getByRole('option', { name: new RegExp(`^${inv.number}`) }).waitFor();
  await box.press('ArrowDown');
  await box.press('ArrowUp');
  await box.press('Enter');
  await page.waitForURL(new RegExp(inv.id));

  // An action: start a new bill.
  await page.keyboard.press('Control+k');
  await box.fill('new bill');
  await dialog.getByRole('option', { name: /^New bill Start/ }).waitFor();
  assert.equal(await dialog.getByRole('option').first().getAttribute('aria-selected'), 'true');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-actions.png` });
  await box.press('Enter');
  await page.waitForURL(new RegExp(`/orgs/${orgId}/purchases/bills/new$`));

  // Nothing found says so.
  await page.keyboard.press('Control+k');
  await box.fill('qqqzzz');
  await dialog.getByText('Nothing matches').waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(consoleErrors, []);
});
