/**
 * Browser end-to-end test for AUDIT-028: an owner attaches a receipt to a bill and posts it; the
 * audit trail shows the receipt as evidence on the posting event, with its checksum, and the link
 * opens the file. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n% fuel receipt\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let browser, page;
const consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the audit trail names the receipt a bill had when it was posted', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Evidence Owner');
  await page.getByLabel('Email').fill(`e2e-audit-evidence-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Audit Evidence Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const orgId = base.split('/orgs/')[1];
  const api = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${api}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = (await call(`${api}/contacts`, { name: 'Highway Fuels', isVendor: true })).body;
  const bill = (await call(`${api}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: T, dueDate: T, lines: [{ accountId: acc['6400'], quantity: '1', unitPrice: '2400.00' }] })).body;

  await page.goto(`${base}/purchases/bills/${bill.id}`);
  await page.getByLabel('Attach files').setInputFiles({ name: 'fuel-receipt.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('list', { name: 'Attached files' }).getByText('fuel-receipt.pdf').waitFor();
  assert.equal((await call(`${api}/purchases/documents/${bill.id}/post`, {})).status, 200);

  await page.goto(`${base}/audit`);
  const row = page.getByRole('row').filter({ hasText: 'document.posted' });
  const link = row.getByRole('link', { name: 'fuel-receipt.pdf' });
  await link.waitFor();
  const sha = createHash('sha256').update(PDF).digest('hex');
  await row.getByTitle(`SHA-256 ${sha}`).waitFor();
  assert.match(await link.getAttribute('href'), /\/attachments\/[0-9a-f-]{36}\/content\?inline=1$/);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/audit-evidence.png` });
  }
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
