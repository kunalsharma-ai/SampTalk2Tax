/**
 * Browser end-to-end test for the CRM pipeline: an owner adds a lead, logs a call, qualifies it,
 * converts it into a new customer with a deal, moves the deal on the board, marks another deal
 * lost with a reason and reopens it, wins one, and sees the deals on the customer's page.
 * Real Next.js app → real API → real PostgreSQL.
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
after(async () => {
  await browser?.close();
});

test('an owner works a lead into a customer and a deal, and moves deals through the pipeline', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Pipeline Owner');
  await page.getByLabel('Email').fill(`e2e-crm-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Pipeline Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);

  // A lead from a referral.
  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('heading', { name: 'Leads', exact: true }).waitFor();
  await page.getByText('No leads yet').waitFor();
  await page.getByRole('button', { name: 'Add a lead' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Priya Nair');
  await dlg.getByLabel('Company').fill('Nair Logistics');
  await dlg.getByLabel('Email').fill('priya@nair.example');
  await dlg.getByLabel('Source').selectOption('REFERRAL');
  await dlg.getByLabel(/Estimated value/).fill('450000');
  await dlg.getByRole('button', { name: 'Add lead' }).click();
  await page.getByRole('heading', { name: /LD-0001 Priya Nair/ }).waitFor();

  // Log a call, qualify, convert with a deal.
  await page.getByLabel('Kind').selectOption('CALL');
  await page.getByLabel('What happened').fill('Wants monthly bookkeeping and GST filing.');
  await page.getByRole('button', { name: 'Log activity' }).click();
  await page.getByRole('list', { name: 'Activity timeline' }).getByText('Wants monthly bookkeeping and GST filing.').waitFor();
  await page.getByRole('button', { name: 'Qualify', exact: true }).click();
  await page.getByRole('list', { name: 'Activity timeline' }).getByText('New → Qualified').waitFor();
  await page.getByRole('button', { name: 'Convert to customer' }).click();
  const conv = page.getByRole('dialog');
  await conv.getByLabel('Deal name').fill('Nair Logistics: bookkeeping');
  await conv.getByLabel(/Amount/).fill('480000');
  await conv.getByRole('button', { name: 'Convert', exact: true }).click();
  await page.getByText('Converted', { exact: true }).first().waitFor();
  await page.getByRole('link', { name: /DL-0001 Nair Logistics: bookkeeping/ }).click();
  await page.getByRole('heading', { name: 'DL-0001 Nair Logistics: bookkeeping' }).waitFor();
  await page.getByText('₹1,20,000.00').waitFor(); // weighted at qualification (25%)

  // Move it on: proposal at 60%.
  await page.getByLabel('Stage', { exact: true }).selectOption('PROPOSAL');
  await page.getByLabel('Win probability (%)').fill('60');
  await page.getByRole('button', { name: 'Update' }).click();
  await page.getByRole('list', { name: 'Activity timeline' }).getByText('Qualification → Proposal (60%)').waitFor();
  await page.getByText('₹2,88,000.00').waitFor();

  // A second deal from the new-deal form, for the same customer, lost and reopened.
  await page.getByRole('link', { name: 'Nair Logistics', exact: true }).click();
  await page.getByRole('heading', { name: 'Nair Logistics' }).waitFor();
  await page.getByRole('table', { name: 'Customer deals' }).getByText('DL-0001 Nair Logistics: bookkeeping').waitFor();
  await page.getByRole('button', { name: 'Add a deal' }).click();
  await page.getByRole('heading', { name: 'Add a deal' }).waitFor();
  await page.getByLabel('Deal name').fill('Payroll outsourcing');
  await page.getByLabel(/Amount/).fill('200000');
  await page.getByRole('button', { name: 'Add deal' }).click();
  await page.getByRole('heading', { name: /DL-0002 Payroll outsourcing/ }).waitFor();
  await page.getByRole('button', { name: 'Mark lost' }).click();
  await page.getByRole('dialog').getByLabel('Why was it lost?').fill('Went with an in-house team');
  await page.getByRole('dialog').getByRole('button', { name: 'Mark lost' }).click();
  await page.getByText('Went with an in-house team').first().waitFor();
  await page.getByRole('button', { name: 'Reopen' }).click();
  await page.getByRole('list', { name: 'Activity timeline' }).getByText(/Reopened: Lost → Negotiation/).waitFor();

  // The board: both deals open; win the first from its card.
  await page.getByRole('link', { name: 'Pipeline', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Pipeline', exact: true }).waitFor();
  const board = page.getByRole('region', { name: 'Proposal' });
  await board.getByText('Nair Logistics: bookkeeping').waitFor();
  await page.getByRole('region', { name: 'Negotiation' }).getByText('Payroll outsourcing').waitFor();
  await page.getByText('₹6,80,000.00').first().waitFor(); // open pipeline
  await page.getByLabel('Move DL-0001').selectOption('WON');
  await page.getByRole('region', { name: 'Proposal' }).getByText('No deals').waitFor();
  await page.getByRole('button', { name: 'Won and lost' }).click();
  await page.getByRole('table', { name: 'Closed deals' }).getByText('DL-0001 Nair Logistics: bookkeeping').waitFor();
  await page.getByText('100%').first().waitFor(); // win rate

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
