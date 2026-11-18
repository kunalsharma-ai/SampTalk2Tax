/**
 * Browser end-to-end test for files on bank statement lines (DOC-006): a bank advice is attached
 * to an imported line from the bank account screen, the line shows its file count, and removing
 * the file needs a reason. Real Next.js app → real API → real MongoDB.
 * Same prerequisites as ledger-flow.test.mjs.
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

async function call(path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a bank advice is attached to a statement line and removed with a reason', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Line Files Owner');
  await page.getByLabel('Email').fill(`e2e-line-files-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Line Files Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;

  const accounts = (await call(`${base}/accounts`)).body;
  const bank = (accounts.items ?? accounts).find((a) => a.code === '1120').id;
  const d = (n) => new Date(Date.now() + 5.5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
  const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'YYYY-MM-DD', hasHeader: true };
  const csv = ['Date,Description,Reference,Amount', `${d(3)},RTGS TO SYNTHETIC STEEL,UTR778,-118000.00`, `${d(2)},BANK CHARGES,,-59.00`].join('\n');
  assert.equal((await call(`${base}/banking/accounts/${bank}/imports`, { fileName: 'synthetic.csv', csv, mapping })).status, 201);

  await page.goto(`${WEB}/orgs/${orgId}/banking/${bank}`);
  const row = page.getByRole('row', { name: /RTGS TO SYNTHETIC STEEL/ });
  await row.getByRole('button', { name: 'Files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Files · RTGS TO SYNTHETIC STEEL/ });
  await dialog.getByText('No files attached.').waitFor();
  await dialog.getByLabel('Attach files').setInputFiles({ name: 'rtgs-advice.pdf', mimeType: 'application/pdf', buffer: PDF });
  await dialog.getByRole('link', { name: 'rtgs-advice.pdf' }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-line-file-attached.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: 'Files (1)' }).waitFor();
  // The other line has none.
  await page.getByRole('row', { name: /BANK CHARGES/ }).getByRole('button', { name: 'Files', exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-line-file-count.png`, fullPage: true });

  await row.getByRole('button', { name: 'Files (1)' }).click();
  await dialog.getByRole('button', { name: 'Remove…' }).click();
  const remove = page.getByRole('dialog', { name: 'Remove rtgs-advice.pdf' });
  await remove.getByLabel('Reason').fill('Advice for another payment');
  await remove.getByRole('button', { name: 'Remove file' }).click();
  await dialog.getByText('No files attached.').waitFor();
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: 'Files', exact: true }).waitFor();

  const line = (await call(`${base}/banking/accounts/${bank}/lines`)).body.lines.find((l) => l.description.includes('RTGS'));
  const all = (await call(`${base}/attachments?entityType=BANK_STATEMENT_LINE&entityId=${line.id}&includeRemoved=true`)).body;
  assert.equal(all.length, 1);
  assert.equal(all[0].removedReason, 'Advice for another payment');
  assert.deepEqual(consoleErrors, []);
});
