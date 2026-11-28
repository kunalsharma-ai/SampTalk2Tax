/**
 * Browser end-to-end test for demonstration organisations (DEMO-001 to DEMO-021): a new person
 * goes from onboarding to the demonstration companies, creates the UK trading business, lands
 * on its demonstration page with the synthetic notice, what was made and the CFO's
 * recommendations, finds the synthetic records in the books and comes back through the badge.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a new person explores a synthetic UK trading business', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Demo');
  await page.getByLabel('Email').fill(`e2e-demo-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding$/);
  await page.getByRole('link', { name: 'Or explore a demonstration organisation with synthetic books first' }).click();
  await page.getByRole('heading', { name: 'Explore a demonstration organisation', exact: true }).waitFor();
  const companies = page.getByRole('list', { name: 'Demonstration companies' });
  await companies.getByRole('heading', { name: 'Market research agency', exact: true }).waitFor();
  assert.deepEqual(await companies.getByRole('heading').allInnerTexts(), [
    'Indian consulting SME',
    'US professional services company',
    'UK trading business',
    'UAE multinational subsidiary',
    'Global manufacturing group',
    'Market research agency',
  ]);
  await page.getByText('Synthetic data only', { exact: true }).waitFor();
  const uk = page.getByTestId('demo-UK_TRADING');
  await uk.getByText('Harbourside Trading Ltd (SYNTHETIC DATA)', { exact: true }).waitFor();
  await uk.getByText('VAT 20% (standard)', { exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/demo-companies.png`, fullPage: true });

  await uk.getByRole('button', { name: 'Create the UK trading business demonstration' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}\/demo$/, { timeout: 180_000 });
  const orgId = page.url().split('/').at(-2);
  await page.getByRole('heading', { name: 'Demonstration organisation', exact: true }).waitFor();
  await page.getByText('Synthetic demonstration data', { exact: true }).waitFor();
  await page.getByText(/does not describe any real business, person or tax registration/).waitFor();
  await page.getByText('Ready', { exact: true }).waitFor();
  const holds = page.getByRole('region', { name: 'What the demo holds' });
  const rows = (await holds.locator('tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  for (const label of ['Customers 4', 'Vendors 3', 'Bills 18', 'Projects 2', 'Departments 2', 'Budgets 1', 'Tax registrations 1']) assert.ok(rows.includes(label), `${label} in ${rows.join(' | ')}`);
  assert.ok(rows.some((r) => /^Invoices \d+$/.test(r)));
  assert.ok(rows.some((r) => r.startsWith('Employees Staff are paid by monthly salary journals') && r.endsWith(' 3')));
  const suggest = page.getByRole('region', { name: 'What the books suggest' });
  await suggest.getByRole('link', { name: 'The full CFO assessment' }).waitFor();
  await page.getByRole('link', { name: 'Synthetic demo data' }).first().waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/demo-summary.png`, fullPage: true });

  // The records are ordinary records, every one named synthetic.
  await holds.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/sales/customers$`));
  await page.getByRole('link', { name: 'Severn Gift Co. (synthetic)', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Lisbon Casa Lda, Portugal (synthetic)', exact: true }).waitFor();

  // The badge on every page leads back to the demonstration page.
  await page.getByRole('link', { name: 'Synthetic demo data' }).first().click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/demo$`));
  await page.getByRole('heading', { name: 'Demonstration organisation', exact: true }).waitFor();
  assert.deepEqual(consoleErrors, []);
});
