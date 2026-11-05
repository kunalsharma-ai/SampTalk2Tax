/**
 * Browser end-to-end test for country modules: a person sets up a UK organisation, sees what the
 * module covers before creating it, finds no India-only pages, and adds the starter VAT rates. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a UK organisation sees its country module and adds the starter VAT rates', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Country Owner');
  await page.getByLabel('Email').fill(`e2e-country-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);

  // Before the organisation exists, the chosen country says what it covers.
  const summary = page.getByTestId('country-summary');
  await summary.getByText('Full tax module').waitFor();
  await page.getByLabel('Country').selectOption('GB');
  await summary.getByText('Starter module').waitFor();
  assert.match(await summary.innerText(), /No VAT return/);
  assert.equal(await page.getByLabel('Functional currency').inputValue(), 'GBP');
  await page.getByLabel('Organisation name').fill('E2E Country UK Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();

  // No India-only pages in the navigation.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Country module', exact: true }).waitFor();
  await nav.getByRole('link', { name: 'Tax rates', exact: true }).waitFor();
  await page.locator('header select option', { hasText: 'E2E Country UK Ltd' }).waitFor({ state: 'attached' });
  for (const name of ['GST returns', 'E-invoices', 'E-way bills', 'TDS and TCS', 'Pay runs', 'Compliance calendar']) {
    assert.equal(await nav.getByRole('link', { name, exact: true }).count(), 0, name);
  }

  await nav.getByRole('link', { name: 'Country module', exact: true }).click();
  await page.getByRole('heading', { name: /United Kingdom/ }).waitFor();
  const covered = page.locator('[aria-label="What is covered"]');
  await covered.getByRole('row', { name: /Sales tax returns.*Not supported/ }).waitFor();
  const starter = page.locator('[aria-label="Starter tax rates"]');
  await starter.getByRole('cell', { name: 'VAT 20% (standard)' }).waitFor();
  await page.locator('[aria-label="Sources"]').getByRole('link', { name: 'GOV.UK: VAT rates' }).waitFor();

  await starter.getByRole('button', { name: 'Add 3 starter rates' }).click();
  await starter.getByRole('status').getByText('Added 3 rates.').waitFor();
  await starter.getByRole('button', { name: 'All starter rates added' }).waitFor();
  assert.equal(await starter.getByText('Added', { exact: true }).count(), 3);

  // The rates are ordinary tax rates, posting to the tax accounts.
  await nav.getByRole('link', { name: 'Tax rates', exact: true }).click();
  await page.getByRole('heading', { name: 'Tax rates', exact: true }).waitFor();
  const row = page.getByRole('row', { name: /VAT 5% \(reduced\)/ });
  await row.waitFor();
  assert.match(await row.innerText(), /2300 · Output Tax Payable/);
  assert.match(await row.innerText(), /1450 · Input Tax Receivable/);

  // The API refuses India-only work for this organisation too.
  const refused = await page.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/payroll/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: '{}' })).json(), orgId);
  assert.equal(refused.error, 'NOT_INDIA');

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
