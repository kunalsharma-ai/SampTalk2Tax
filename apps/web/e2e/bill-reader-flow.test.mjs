/**
 * Browser end-to-end test for the bill reader (AP-025): an owner uploads a supplier's PDF bill,
 * sees what was found (supplier, number, dates, items, taxes, total) and the checks, reviews the
 * bill form filled in from it, saves it as a draft bill with the PDF attached, and finds the
 * reading marked as saved. Pasted text is read and discarded. A PDF is read in the background
 * (PERF-013): the reading page says it is being read and updates by itself, and a scan with no
 * text ends as a reading that could not be read, saying why. Real Next.js app → real API →
 * real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const ok = (r, what) => {
  assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

/** A one-page PDF bill, laid out in columns as billing software prints it, with a compressed content stream; or, with text false, a page with only a grey box, as a scan has. */
function billPdf({ text = true } = {}) {
  const esc = (s) => s.replace(/[()\\]/g, (c) => `\\${c}`);
  const at = (x, y, size, s) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(s)}) Tj ET`;
  const rows = [
    ['Steel brackets', '7326', '10', '450.00', '4,500.00'],
    ['Fitting service', '9987', '2', '1,250.00', '2,500.00'],
  ];
  const ops = [at(40, 790, 16, 'Granite Parts Pvt Ltd'), at(40, 772, 9, 'GSTIN: 27AAACG1234F1Z4'), at(400, 790, 14, 'TAX INVOICE'), at(400, 764, 10, 'Invoice No: GP/2026/118'), at(400, 750, 10, 'Invoice Date: 05/10/2026'), at(400, 736, 10, 'Due Date: 04/11/2026')];
  let y = 690;
  ['Description', 'HSN', 'Qty', 'Rate', 'Amount'].forEach((h, i) => ops.push(at([40, 250, 320, 380, 470][i], y, 10, h)));
  for (const r of rows) {
    y -= 16;
    r.forEach((c, i) => ops.push(at([40, 250, 320, 380, 470][i], y, 10, c)));
  }
  for (const [k, v] of [['Sub Total', '7,000.00'], ['CGST @ 9%', '630.00'], ['SGST @ 9%', '630.00'], ['Grand Total', 'Rs. 8,260.00']]) {
    y -= 16;
    ops.push(at(380, y, 10, k), at(470, y, 10, v));
  }
  const content = deflateSync(Buffer.from(text ? ops.join('\n') : '0.5 g 40 40 300 400 re f', 'latin1'));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  objs.forEach((o, i) => {
    if (o) parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1'));
    else parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  });
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  const file = join(mkdtempSync(join(tmpdir(), 'bill-')), text ? 'granite-gp-118.pdf' : 'scanned-bill.pdf');
  writeFileSync(file, Buffer.concat(parts));
  return file;
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner reads a PDF bill, reviews it in the bill form and saves it with the PDF attached', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Bina Bills');
  await page.getByLabel('Email').fill(`e2e-billreader-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Bill Reader Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set(ok(await call(`${base}/periods`), 'periods').map((p) => p.fiscalYear));
  if (!years.has(2027)) ok(await call(`${base}/periods/fiscal-years`, { fiscalYear: 2027 }), 'fiscal year');
  ok(await call(`${base}/contacts`, { name: 'Granite Parts Private Limited', isVendor: true }), 'vendor');
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/purchases/bill-reader`);
  await page.getByText('No bills read yet').waitFor();
  await page.getByLabel('The bill as a PDF (up to 5 MB)').setInputFiles(billPdf());
  await page.getByRole('button', { name: 'Read the PDF' }).click();
  await page.waitForURL(/\/purchases\/bill-reader\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'BR-0001 · Granite Parts Private Limited GP/2026/118' }).waitFor();

  const found = page.getByRole('region', { name: 'What the reader found' });
  await found.getByText('GP/2026/118').waitFor();
  await found.getByText('27AAACG1234F1Z4').waitFor();
  assert.equal(await found.getByText('Found on the bill').count(), 7);
  const amounts = page.getByRole('region', { name: 'Amounts on the bill' });
  await amounts.getByRole('cell', { name: 'Steel brackets' }).waitFor();
  await amounts.getByRole('cell', { name: 'CGST @ 9%' }).waitFor();
  await amounts.getByRole('cell', { name: '₹8,260.00' }).waitFor();
  await page.getByRole('list', { name: 'Checks' }).getByText('Granite Parts Private Limited has no GSTIN recorded; the bill shows 27AAACG1234F1Z4').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bill-reader.png`, fullPage: true });

  // The bill form is filled in from the bill; the person picks the accounts and saves a draft.
  const review = page.getByRole('region', { name: 'Review and save' });
  assert.equal(await review.getByLabel("Vendor's invoice number").inputValue(), 'GP/2026/118');
  assert.equal(await review.getByLabel('Description for line 2').inputValue(), 'Fitting service');
  assert.equal(await review.getByLabel('Quantity for line 1').inputValue(), '10');
  assert.equal(await review.getByLabel('Unit price for line 2').inputValue(), '1250.00');
  await review.getByLabel('Account for line 1').selectOption({ label: '5000 · Cost of Sales' });
  await review.getByLabel('Account for line 2').selectOption({ label: '5000 · Cost of Sales' });
  await review.getByRole('button', { name: 'Save as draft' }).click();
  await page.waitForURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  await page.getByText('granite-gp-118.pdf').first().waitFor();

  await page.goto(`${WEB}/orgs/${orgId}/purchases/bill-reader`);
  const list = page.getByRole('table', { name: 'Bills read' });
  await list.getByText('Saved as a bill').waitFor();
  await list.getByRole('link', { name: 'Draft bill' }).waitFor();

  // Pasted text is read too, and a reading that is not a bill is discarded.
  await page.getByLabel('Or paste the text of the bill').fill('Acme Software Inc\nInvoice #INV-77\nInvoice date: Oct 12, 2026\nAmount due   $ 500.00');
  await page.getByRole('button', { name: 'Read the text' }).click();
  await page.getByRole('heading', { name: 'BR-0002 · Acme Software Inc INV-77' }).waitFor();
  await page.getByRole('list', { name: 'Checks' }).getByText('Acme Software Inc is not one of your vendors yet; choose the vendor or add them first').waitFor();
  await page.getByRole('button', { name: 'Discard this reading' }).click();
  await page.getByText('Nothing was saved to the books.').waitFor();

  // A scan has no text: the upload is accepted, and the reading then says it could not be read.
  await page.goto(`${WEB}/orgs/${orgId}/purchases/bill-reader`);
  await page.getByLabel('The bill as a PDF (up to 5 MB)').setInputFiles(billPdf({ text: false }));
  await page.getByRole('button', { name: 'Read the PDF' }).click();
  await page.waitForURL(/\/purchases\/bill-reader\/[0-9a-f-]{36}$/);
  const failed = page.getByRole('alert').filter({ hasText: 'The bill could not be read' });
  await failed.getByText('This PDF has no text to read; it is probably a scan or a photo.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Review and save' }).count(), 0);
  await page.getByRole('link', { name: 'Read another bill' }).click();
  await page.getByRole('table', { name: 'Bills read' }).getByText('Could not be read', { exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bill-reader-failed.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
