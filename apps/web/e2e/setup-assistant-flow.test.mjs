/**
 * Browser end-to-end test for the onboarding assistant (UX-020 to UX-022): a new owner describes
 * the business, reviews each recommendation (accepting the profile ones fills the business
 * profile, nothing else changes on its own), and the checklist holds activation until every
 * recommendation is decided. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the owner describes the business and reviews every recommendation', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Asha Assistant');
  await page.getByLabel('Email').fill(`e2e-assist-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Assistant Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}/setup`);

  await page.getByLabel('What does your business do?').fill('We run a design consulting agency with 8 people. Clients pay a monthly retainer and we work in projects.');
  await page.getByRole('button', { name: 'Recommend setup' }).click();
  const recs = page.getByRole('table', { name: 'Recommendations' });
  await recs.getByText('Industry: Professional services').waitFor();
  assert.equal(await recs.getByRole('button', { name: /^Accept: / }).count(), 7);
  assert.equal(await page.getByLabel('Industry', { exact: true }).inputValue(), '');
  await page.getByRole('row', { name: /Assistant recommendations/ }).getByText('To do').waitFor();
  await shot('setup-assistant-recommendations');

  for (const title of ['Industry: Professional services', 'Business size: 1 to 10 people']) await page.getByRole('button', { name: `Accept: ${title}` }).click();
  await page.getByRole('button', { name: /^Accept: Accounting framework/ }).click();
  await page.getByRole('button', { name: /^Accept: AI agents/ }).click();
  await page.getByRole('button', { name: 'Accept: Bill recurring work from contracts' }).click();
  await recs.getByRole('link', { name: 'Go there' }).waitFor();
  for (const title of ['Set up payroll', 'Track projects with a dimension']) await page.getByRole('button', { name: `Dismiss: ${title}` }).click();
  await page.getByRole('row', { name: /Assistant recommendations/ }).getByText('Done').waitFor();
  assert.equal(await page.getByLabel('Industry', { exact: true }).inputValue(), 'PROFESSIONAL_SERVICES');
  assert.equal(await page.getByLabel('Business size', { exact: true }).inputValue(), 'MICRO');
  assert.equal(await page.getByLabel('AI agents', { exact: true }).inputValue(), 'PREPARE');
  assert.equal(await recs.getByText('Accepted').count(), 5);
  assert.equal(await recs.getByText('Dismissed').count(), 2);
  await shot('setup-assistant-reviewed');
  assert.deepEqual(consoleErrors, []);
});
