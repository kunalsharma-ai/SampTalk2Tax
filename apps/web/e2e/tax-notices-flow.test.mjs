/**
 * Browser end-to-end test for tax notices (TAX-024): the owner records a GST notice from the
 * letter, adds the letter, records the reply and closes it; the history keeps every step.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);
const iso = (n) => new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a GST notice is recorded, answered and closed', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Notice Owner');
  await page.getByLabel('Email').fill(`e2e-notice-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Tax Notices Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();

  await page.getByRole('link', { name: 'Tax notices' }).click();
  await page.getByRole('heading', { name: 'Tax notices' }).waitFor();
  await page.getByText('Record a notice when one arrives', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Record a notice' }).click();
  await page.getByLabel('Notice number').fill('ZD2711250099887');
  await page.getByLabel('Form or section (optional)').fill('ASMT-10');
  await page.getByLabel('Period (optional)').fill('2025-26');
  await page.getByLabel('What it is about').fill('Difference between GSTR-1 and GSTR-3B (synthetic)');
  await page.getByLabel('Received on').fill(iso(-6));
  await page.getByLabel('Reply due (optional)').fill(iso(3));
  await page.getByLabel(/Amount demanded/).fill('48250');
  await page.getByRole('button', { name: 'Record notice' }).click();
  await page.waitForURL(/\/tax\/notices\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'GST notice ZD2711250099887' }).waitFor();
  await page.getByText('Due in 3 days').waitFor();

  await page.getByLabel('Add files').setInputFiles({ name: 'asmt-10.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('link', { name: 'asmt-10.pdf' }).waitFor();
  await page.getByRole('button', { name: 'Record the reply' }).click();
  await page.getByLabel('What was sent').fill('ASMT-11 with a reconciliation of the two returns');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Replied', { exact: true }).waitFor();
  await shot('02-notice-replied');

  await page.getByRole('button', { name: 'Close…' }).click();
  await page.getByLabel('Outcome').selectOption('DROPPED');
  await page.getByLabel('How it ended').fill('The officer accepted the reconciliation');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Closed · Dropped with no demand').waitFor();
  const history = page.getByRole('region', { name: 'Notice history' });
  for (const k of ['Received', 'File added', 'Reply sent', 'Closed']) await history.getByText(k, { exact: true }).waitFor();

  // Another, overdue, shows first in the list.
  const r = await page.evaluate(async ([o, d]) => (await fetch(`/api/t2t/v1/orgs/${o}/tax-notices`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ authority: 'INCOME_TAX', reference: 'ITBA/AST/S/143(2)/SYN', section: '143(2)', subject: 'Scrutiny of return (synthetic)', receivedOn: d[0], responseDue: d[1] }) })).status, [orgId, [iso(-20), iso(-2)]]);
  assert.equal(r, 201);
  await page.goto(`${WEB}/orgs/${orgId}/tax/notices`);
  await page.getByText('Overdue by 2 days').waitFor();
  const first = await page.getByRole('row').nth(1).textContent();
  assert.match(first, /Income tax · ITBA/);
  await shot('01-notices');
  assert.deepEqual(consoleErrors, []);
});
