/**
 * Browser end-to-end test for upload checks (SEC-018/019): an owner attaches a vendor's PDF to a
 * bill, and a PDF that can run JavaScript is refused with the reason and not kept; a platform
 * administrator sees the refusal under Platform admin → File scanning.
 * Real Next.js app → real API → real MongoDB. (No virus scanner runs in this test; the API's
 * own scanning against a ClamAV stand-in is covered by apps/api/test/file-scanning.e2e.test.ts.)
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const SHOTS = process.env.SHOTS_DIR;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser;
const consoleErrors = [];

const pdf = (extra) => Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R ${extra} >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');

async function register(name, email) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  return page;
}

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

test('a PDF that can run code is refused, and admins see it', async () => {
  const tag = randomUUID().slice(0, 8);
  const page = await register('Upload Owner', `e2e-scan-${tag}@example.test`);
  await page.getByLabel('Organisation name').fill(`E2E Upload Checks ${tag}`);
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const bill = await page.evaluate(async ([orgId, T]) => {
    const call = (u, b) => fetch(`/api/t2t/v1/orgs/${orgId}${u}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
    const acc = Object.fromEntries((await call('/accounts')).map((a) => [a.code, a.id]));
    const vendor = await call('/contacts', { name: 'Synthetic Supplies', isVendor: true });
    return call('/purchases/documents', { kind: 'BILL', contactId: vendor.id, issueDate: T, reference: 'SCAN-77', lines: [{ accountId: acc['6600'], quantity: '1', unitPrice: '1000.00' }] });
  }, [orgId, T]);

  await page.goto(`${WEB}/orgs/${orgId}/purchases/bills/${bill.id}`);
  const input = page.locator('input[type=file][aria-label="Attach files"]');
  await page.locator('button', { hasText: 'Attach files' }).waitFor();
  await input.setInputFiles({ name: 'invoice-scripted.pdf', mimeType: 'application/pdf', buffer: pdf('/OpenAction << /S /JavaScript /JS (app.launchURL("https://example.test")) >>') });
  const refused = page.getByRole('alert').filter({ hasText: 'Could not attach the file' });
  await refused.getByText(/can run code or carries other files \(JavaScript, JS\)/).waitFor();
  await refused.scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/upload-refused.png` });
  await input.setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: pdf('/Producer (Synthetic)') });
  await page.getByRole('link', { name: 'invoice.pdf' }).or(page.getByText('invoice.pdf', { exact: true })).first().waitFor();
  assert.equal(await page.getByText('invoice-scripted.pdf').count(), 0);

  const adminEmail = `e2e-scan-admin-${tag}@example.test`;
  const admin = await register('Scan Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });
  await admin.goto(`${WEB}/admin/file-scanning`);
  const row = admin.locator('table[aria-label="Refused files"]').getByRole('row').filter({ hasText: 'invoice-scripted.pdf' });
  await row.getByText('Scripts or embedded files').waitFor();
  assert.match(await row.innerText(), new RegExp(`E2E Upload Checks ${tag}[\\s\\S]*Attachments`));
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/admin-file-scanning.png` });
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|42[0-9]|Failed to load resource/.test(e)), []);
});
