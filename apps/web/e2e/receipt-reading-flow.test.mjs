/**
 * Browser end-to-end test for receipt reading (EXP-004): an owner picks a photo of a café bill on
 * Receipt matching; Talk2Tax reads it with OCR inside the API and fills the merchant, date and
 * amount, showing how sure it is of each, the GST lines and the GSTIN. Adding the receipt attaches
 * the photo. The same photo read on a new expense claim fills the first line. Real Next.js app →
 * real API (Tesseract OCR in the API process) → real MongoDB; no outside service.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const PHOTO = readFileSync(new URL('../../api/test/fixtures/receipt-cafe.jpg', import.meta.url));
let browser, page;
const consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a receipt photo is read into the receipt form and an expense claim line', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Receipt Reading Owner');
  await page.getByLabel('Email').fill(`e2e-receipt-ocr-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Receipt Reading Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();

  // Receipt matching: read the photo, and the form fills in.
  await page.goto(`${base}/expenses/receipts`);
  await page.getByRole('heading', { name: 'Receipt matching' }).waitFor();
  const form = page.getByRole('region', { name: 'Add a receipt' });
  await form.getByRole('region', { name: 'Read a receipt' }).locator('input[type="file"]').setInputFiles({ name: 'chai.jpg', mimeType: 'image/jpeg', buffer: PHOTO });
  const read = form.getByLabel('What was read');
  await read.waitFor({ timeout: 60_000 });
  assert.equal(await form.getByLabel('Merchant').inputValue(), 'CHAI POINT CAFE');
  assert.equal(await form.getByLabel('Date on the receipt').inputValue(), '2026-11-14');
  assert.equal(await form.getByLabel(/^Amount/).inputValue(), '420.00');
  const shown = await read.innerText();
  assert.match(shown, /Merchant\s+CHAI POINT CAFE\s+Check/);
  assert.match(shown, /Total\s+₹420\.00\s+Read clearly/);
  assert.match(shown, /GSTIN\s+29ABCDE1234F1Z\w\s+Read clearly/);
  assert.match(shown, /CGST 2\.5% 10\.00, SGST 2\.5% 10\.00 \(subtotal and tax add up to the total\)/);
  await form.getByText(/Characters read with \d+% confidence\./).waitFor();
  if (SHOTS) await form.screenshot({ path: `${SHOTS}/receipt-reading.png` });

  // Adding the receipt attaches the photo that was read.
  await form.getByRole('button', { name: 'Add receipt' }).click();
  await page.waitForURL(/\/expenses\/receipts\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: /RC-001: CHAI POINT CAFE/ }).waitFor();
  await page.getByRole('list', { name: 'Attached files' }).getByText('chai.jpg').waitFor();

  // A new expense claim: the photo fills the first line.
  await page.goto(`${base}/expenses/new`);
  await page.getByRole('region', { name: 'Read a receipt into a line' }).locator('input[type="file"]').setInputFiles({ name: 'chai.jpg', mimeType: 'image/jpeg', buffer: PHOTO });
  await page.getByLabel('What was read').waitFor({ timeout: 60_000 });
  assert.equal(await page.getByLabel('Merchant for line 1').inputValue(), 'CHAI POINT CAFE');
  assert.equal(await page.getByLabel('Amount for line 1').inputValue(), '420.00');
  assert.equal(await page.getByLabel('Date for line 1').inputValue(), '2026-11-14');
  assert.equal(await page.getByLabel('Merchant for line 2').count(), 0);

  // Something that is not a receipt is refused with a reason.
  await page
    .getByRole('region', { name: 'Read a receipt into a line' })
    .locator('input[type="file"]')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.getByText('Upload a photo (JPEG, PNG or WebP) or a PDF of the receipt').waitFor();
  consoleErrors.length = 0; // the refused upload logs a 415

  assert.deepEqual(
    consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)),
    [],
  );
});
