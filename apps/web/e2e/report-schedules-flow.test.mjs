/**
 * Browser end-to-end test for scheduled reports (RPT-031, RPT-032): an owner sets up a monthly
 * profit and loss for themselves, sends it now, and the PDF arrives by email; then pauses it.
 * Real Next.js app → real API → real MongoDB → nodemailer → a local SMTP server run here
 * (test-support/smtp-stand-in.mjs). The API must run with SMTP_URL=smtp://127.0.0.1:4556 and
 * EMAIL_FROM set, as in CI.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startSmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const SMTP_PORT = Number(process.env.SMTP_STAND_IN_PORT ?? 4556);
let browser, page, smtp;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

before(async () => {
  smtp = await startSmtpStandIn(SMTP_PORT);
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await smtp?.close();
});

test('an owner schedules the monthly profit and loss, sends it now, and gets the PDF by email', async () => {
  const email = `e2e-schedule-${randomUUID()}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Schedule Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Schedules Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();

  await page.goto(`${WEB}/orgs/${orgId}/reports/schedules`);
  await page.getByText('No scheduled reports').waitFor();
  await page.getByRole('button', { name: 'New schedule' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Monthly P&L for the owners');
  await dialog.getByLabel('Report').selectOption('income-statement');
  await dialog.getByLabel('Covers').selectOption('LAST_MONTH');
  await dialog.getByLabel('Day of the month').fill('3');
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Save schedule' }).click();
  await dialog.waitFor({ state: 'hidden' });

  const row = page.getByRole('row', { name: /Monthly P&L for the owners/ });
  await row.getByText('Monthly on day 3').waitFor();
  await row.getByText('Not yet').waitFor();
  const before = smtp.messages.length;
  await row.getByRole('button', { name: 'Send now' }).click();
  await page.getByText(/went to/).waitFor();
  await row.getByText('Sent', { exact: true }).waitFor();
  assert.equal(smtp.messages.length, before + 1);
  const m = smtp.messages[before];
  assert.deepEqual(m.to, [email.toLowerCase()]);
  assert.match(m.subject, /^Profit and loss, \d{4}-\d{2}-01 to \d{4}-\d{2}-\d{2}: E2E Schedules Co$/);
  assert.ok(m.attachments.some((a) => a.contentType.startsWith('application/pdf') && a.data.subarray(0, 5).toString() === '%PDF-'));
  await shot('01-scheduled-reports');

  await row.getByRole('button', { name: 'Pause' }).click();
  await row.getByText('Paused').waitFor();
  assert.deepEqual(consoleErrors, []);
});
