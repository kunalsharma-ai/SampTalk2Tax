/**
 * Browser end-to-end test for the reporting studio (RPT-001): an owner opens Reports → Reporting
 * studio from the navigation, finds the ageing reports by searching, pins one, sees it under
 * Pinned reports after a reload, exports the trial balance and sees it in the latest exports,
 * then opens a report from the catalogue. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page;
let consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner finds, pins and opens reports in the reporting studio', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Studio Owner');
  await page.getByLabel('Email').fill(`e2e-studio-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Studio Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const exported = await page.evaluate(
    async ([o, t]) => (await fetch(`/api/t2t/v1/orgs/${o}/reports/export/trial-balance?format=csv&asOf=${t}`, { headers: { 'x-t2t-csrf': '1' } })).status,
    [orgId, T],
  );
  assert.equal(exported, 200);
  consoleErrors = [];

  await page.getByRole('link', { name: 'Reporting studio', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/reports$`));
  await page.getByRole('heading', { name: 'Reporting studio', exact: true }).waitFor();
  const catalogue = page.getByRole('region', { name: 'Report catalogue' });
  await catalogue.getByRole('link', { name: 'Balance sheet', exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'Latest exports' })
    .getByRole('table', { name: 'Exports' })
    .getByRole('row', { name: /Trial balance CSV Studio Owner/ })
    .waitFor();

  // Search narrows the catalogue to reports matching every word.
  await page.getByLabel('Find a report').fill('owe late');
  await catalogue.getByRole('link', { name: 'Receivables ageing', exact: true }).waitFor();
  assert.equal(await catalogue.getByRole('link').count(), 1);
  await page.getByLabel('Find a report').fill('zzzz');
  await catalogue.getByRole('status').getByText('No report matches').waitFor();
  await page.getByLabel('Find a report').fill('ageing');
  await catalogue.getByRole('button', { name: 'Pin Receivables ageing' }).click();
  const pinned = page.getByRole('list', { name: 'Your pinned reports' });
  await pinned.getByRole('link', { name: 'Receivables ageing', exact: true }).waitFor();

  // Pins are kept.
  await page.reload();
  await page.getByRole('list', { name: 'Your pinned reports' }).getByRole('link', { name: 'Receivables ageing', exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/reporting-studio.png`, fullPage: true });

  await page.getByRole('region', { name: 'Report catalogue' }).getByRole('link', { name: 'Profit and loss', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/reports/income-statement`));
  assert.deepEqual(consoleErrors, []);
});
