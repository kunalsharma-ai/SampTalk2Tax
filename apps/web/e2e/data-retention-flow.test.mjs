/**
 * Browser end-to-end test for data retention (SEC-020): an owner opens Data retention, sees the
 * Indian record-keeping periods, sets copilot conversations to be deleted after 180 days, is
 * refused a period shorter than the minimum, and applies the periods now.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
let browser, page;
const consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
});

test('an owner sets retention periods and applies them', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Retention Owner');
  await page.getByLabel('Email').fill(`e2e-retention-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Retention Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}/settings/retention`);

  const law = page.locator('table[aria-label="Records kept by law"]');
  await law.getByText('Companies Act, 2013, section 128(5)').waitFor();
  assert.match(await law.innerText(), /GST records[\s\S]*72 months[\s\S]*CGST Act, 2017, section 36/);

  const working = page.locator('table[aria-label="Working data"]');
  const row = working.getByRole('row').filter({ hasText: 'Copilot conversations' });
  await row.getByLabel('Copilot conversations kept').selectOption('days');
  // Shorter than the minimum is refused.
  await row.getByLabel('Copilot conversations days').fill('30');
  await row.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('alert').filter({ hasText: 'the shortest period is 90 days' }).waitFor();
  await row.getByLabel('Copilot conversations days').fill('180');
  await row.getByRole('button', { name: 'Save' }).click();
  await working.getByRole('row').filter({ hasText: 'Copilot conversations' }).getByRole('button', { name: 'Save' }).and(page.locator('[disabled]')).waitFor();
  await page.reload();
  assert.equal(await working.getByLabel('Copilot conversations days').inputValue(), '180');
  assert.equal(await working.getByLabel('CRM webhook delivery log kept').inputValue(), 'keep');

  await page.getByRole('button', { name: 'Apply now' }).click();
  const runs = page.locator('table[aria-label="Retention runs"]');
  await runs.getByRole('row').filter({ hasText: 'Apply now' }).filter({ hasText: 'Copilot conversations: 0' }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/data-retention.png`, fullPage: true });
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
