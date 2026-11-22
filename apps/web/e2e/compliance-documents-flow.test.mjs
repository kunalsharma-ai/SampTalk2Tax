/**
 * Browser end-to-end test for compliance document management (TAX-025): two GSTR-1 returns are
 * marked filed; the page lists both as missing their acknowledgement, Add fills in the form for
 * one, the PDF is attached on the document's page, and the return drops off the missing list.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const monthOf = (back) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fiscalYear = (m) => (Number(m.slice(5, 7)) >= 4 ? Number(m.slice(0, 4)) + 1 : Number(m.slice(0, 4)));
const PDF = Buffer.from('%PDF-1.4\n% gstr1 ack\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let browser, page;
const consoleErrors = [];

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1); // not money
    sum += Math.floor(p / 36) + (p % 36); // not money
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36];
};

async function call(path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('Compliance documents lists missing acknowledgements and files one', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Devika Documents');
  await page.getByLabel('Email').fill(`e2e-compdocs-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Compliance Documents Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  for (const fy of new Set([3, 2, 1].map((b) => fiscalYear(monthOf(b))))) await call(`${B}/periods/fiscal-years`, { fiscalYear: fy });
  await must(call(`${B}/gst/registration`, { gstin: gstin('29ZZZCD9001Z1Z'), legalName: 'E2E Compliance Documents Co', effectiveFrom: `${monthOf(3)}-01` }, 'PUT'));
  for (const back of [2, 1]) await must(call(`${B}/compliance/filings`, { key: `GSTR1:${monthOf(back)}`, filedOn: `${monthOf(back - 1)}-10`, reference: `ARN${back}` }));
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/compliance-documents`);
  await page.getByRole('heading', { name: 'Compliance documents' }).waitFor();
  const missing = page.getByRole('table', { name: 'Missing documents' });
  const row = missing.getByRole('row').filter({ hasText: 'GSTR-1' }).filter({ hasText: label(monthOf(1)) });
  assert.match(await row.innerText(), /Acknowledgement/);
  await missing.getByRole('row').filter({ hasText: 'GSTR-1' }).filter({ hasText: label(monthOf(2)) }).waitFor();
  await page.getByText('0 of 2 returns filed and payments made in the last year have their acknowledgement or challan on file.').waitFor();

  await row.getByRole('button', { name: 'Add acknowledgement' }).click();
  const form = page.getByRole('region', { name: 'Add a compliance document' });
  assert.equal(await form.getByLabel('Kind of document').inputValue(), 'ACKNOWLEDGEMENT');
  assert.match(await form.getByLabel('Title').inputValue(), new RegExp(`GSTR-1.*${label(monthOf(1))}: acknowledgement`));
  await form.getByLabel('Reference').fill('AA2911260012345');
  await form.getByRole('button', { name: 'Add document' }).click();
  await page.waitForURL(/\/tax\/compliance-documents\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: /^CD-001: GSTR-1/ }).waitFor();
  await page.getByLabel('Attach files').setInputFiles({ name: 'gstr1-ack.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('list', { name: 'Attached files' }).getByText('gstr1-ack.pdf').waitFor();

  await page.getByRole('link', { name: 'All documents' }).click();
  await page.getByText('1 of 2 returns filed and payments made in the last year have their acknowledgement or challan on file.').waitFor();
  assert.equal(await missing.getByRole('row').filter({ hasText: label(monthOf(1)) }).count(), 0);
  const onFile = page.getByRole('table', { name: 'Documents on file' });
  assert.match(await onFile.innerText(), /CD-001[\s\S]*AA2911260012345[\s\S]*Acknowledgement[\s\S]*gstr1-ack\.pdf/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/compliance-documents.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
