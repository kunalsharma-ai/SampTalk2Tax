/**
 * Browser end-to-end test for tax document interpretation (TAX-043): an Indian company pastes a
 * TDS certificate on Tax → Tax documents, sees what it is and what to do, the checks against its
 * PAN, and every field with the line it came from, then marks it reviewed; a challan for another
 * GSTIN is flagged as a problem. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => {
  const r = await p;
  assert.ok(r.status < 300, JSON.stringify(r));
  return r.body;
};

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

const PAN = 'ZZZTE0001Z';
const GSTIN = `29${PAN}1Z${gstinCheckCharacter(`29${PAN}1Z`)}`;

test('an Indian company reads a TDS certificate and a GST challan', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Taxdocs');
  await page.getByLabel('Email').fill(`e2e-taxdocs-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Tax Documents Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const T = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await must(call(`${B}/gst/registration`, { gstin: GSTIN, legalName: 'E2E Tax Documents Co', effectiveFrom: `${T.slice(0, 7)}-01` }, 'PUT'));
  consoleErrors = [];

  await page.getByRole('link', { name: 'Tax documents', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/tax/documents$`));
  await page.getByRole('heading', { name: 'Tax documents', exact: true }).waitFor();
  const certificate = [
    'FORM NO. 16A',
    'Certificate under section 203 of the Income-tax Act, 1961 for tax deducted at source',
    'Name of the Deductor: Synthetic Buyer Private Limited',
    'TAN of the Deductor: BLRS12345A',
    `PAN of the Deductee: ${PAN}`,
    'Assessment Year 2026-27',
    'Section 194C',
    'Amount paid/credited 50,000.00',
    'Amount of tax deducted 1,000.00',
    'Amount of tax deposited 1,000.00',
  ].join('\n');
  await page.getByLabel('Or paste the text of the document').fill(certificate);
  await page.getByRole('button', { name: 'Read the text' }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/tax/documents/[0-9a-f-]{36}$`));
  await page.getByRole('heading', { name: 'TD-0001: TDS certificate (Form 16A)', exact: true }).waitFor();
  const checks = page.getByRole('region', { name: 'Checks on the document' });
  await checks.getByText('The certificate is for your PAN.', { exact: true }).waitFor();
  await checks.getByText(/Tax deducted is 2% of the amount paid/).waitFor();
  const fields = page.getByRole('table', { name: 'What the document says' });
  await fields.getByRole('row', { name: "Deductor's TAN BLRS12345A TAN of the Deductor: BLRS12345A" }).waitFor();
  await fields.getByRole('row', { name: /Tax deducted 1000\.00/ }).waitFor();
  const review = page.getByRole('region', { name: 'Review this document' });
  await review.getByLabel('Note (optional)').fill('Booked to TDS receivable');
  await review.getByRole('button', { name: 'Mark reviewed' }).click();
  await review.getByText('Booked to TDS receivable', { exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-document.png`, fullPage: true });

  await page.getByRole('link', { name: 'All tax documents', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/tax/documents$`));
  const other = `27ZZZXX0002Z1Z${gstinCheckCharacter('27ZZZXX0002Z1Z')}`;
  await page
    .getByLabel('Or paste the text of the document')
    .fill(['Form GST PMT-06', 'CPIN: 26112900054321', `GSTIN: ${other}`, 'IGST Tax 0.00 7,200.00', 'Total Challan Amount: 7,200.00'].join('\n'));
  await page.getByRole('button', { name: 'Read the text' }).click();
  await page.getByRole('heading', { name: 'TD-0002: GST payment challan (GST PMT-06)', exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'Checks on the document' })
    .getByText(`The challan is for GSTIN ${other}, not yours (${GSTIN}). The payment would go to another ledger.`, { exact: true })
    .waitFor();
  await page.getByRole('link', { name: 'All tax documents', exact: true }).click();
  const list = page.getByRole('table', { name: 'Tax documents read' });
  await list.getByRole('row', { name: /TD-0002 .* GST payment challan \(GST PMT-06\) — To review 2 to check/ }).waitFor();
  await list.getByRole('row', { name: /TD-0001 .* TDS certificate \(Form 16A\) 2025-26 Reviewed/ }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-documents.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
