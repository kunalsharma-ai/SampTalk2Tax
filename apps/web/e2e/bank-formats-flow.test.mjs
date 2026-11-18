/**
 * Browser end-to-end test for statement formats (BANK-003): an MT940 file is recognised without
 * any column mapping, the preview says it does not add up to the bank's closing balance, and
 * its lines are imported. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const MT940 = [
  ':20:STMT2611',
  ':25:50200012345678',
  ':60F:C261031INR100000,00',
  ':61:2611031103C11800,00NTRFUTR778812//N3031',
  ':86:NEFT HARBOUR CAFE',
  ':61:2611051105D500,00NCHG004512',
  ':86:BANK CHARGES',
  ':62F:C261105INR112300,00',
].join('\n');

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an MT940 statement is read without mapping and flagged when it does not add up', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Format Owner');
  await page.getByLabel('Email').fill(`e2e-formats-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Formats Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}/banking`);
  await page.getByRole('link', { name: '1120 · Operating Bank Account' }).click();
  await page.getByRole('link', { name: 'Import a statement' }).click();
  await page.getByLabel('Statement file').setInputFiles({ name: 'hdfc-nov.sta', mimeType: 'text/plain', buffer: Buffer.from(MT940) });
  await page.getByText('MT940 file').waitFor();
  assert.equal(await page.getByLabel('Date column').count(), 0);
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('heading', { name: '2 new lines' }).waitFor();
  await page.getByText("The file does not add up to the bank's closing balance").waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/statement-formats-mt940.png` });
  await page.getByRole('button', { name: 'Import 2 lines' }).click();
  await page.waitForURL(/\/banking\/[0-9a-f-]{36}$/);
  await page.getByRole('cell', { name: 'NEFT HARBOUR CAFE' }).waitFor();
  await page.getByRole('cell', { name: 'BANK CHARGES' }).waitFor();
  assert.deepEqual(consoleErrors, []);
});
