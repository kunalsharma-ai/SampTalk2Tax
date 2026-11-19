/**
 * Browser end-to-end test for encryption keys (SEC-013): a platform administrator opens
 * Platform admin → Encryption keys and sees each kind of stored secret counted by the key that
 * encrypted it. Re-encrypting is covered by the API test, which runs servers with old and new
 * keys. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const SHOTS = process.env.SHOTS_DIR;
let browser;
const consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

test('an administrator sees which key encrypts the stored secrets', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const email = `e2e-keys-admin-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Keys Admin');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', email], { cwd: API_DIR, encoding: 'utf8' });

  await page.goto(`${WEB}/admin`);
  await page.getByRole('link', { name: 'Encryption keys', exact: true }).click();
  await page.waitForURL(/\/admin\/encryption-keys$/);
  const table = page.getByRole('table', { name: 'Encrypted secrets' });
  await table.waitFor();
  const rows = await table.locator('tbody tr').allInnerTexts();
  assert.deepEqual(rows.map((r) => r.split('\t')[0].trim()), ['AI and email keys (Settings → Integrations)', "Organisations' payment gateways", 'Platform payment gateways', 'CRM webhook signing secrets', 'Single sign-on client secrets', 'Two-step sign-in authenticators']);
  await page.getByText('No previous key listed').waitFor();
  // Nothing is under a previous key on this server, so there is nothing to re-encrypt.
  assert.equal(await page.getByRole('button', { name: /^Re-encrypt/ }).isDisabled(), true);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/admin-encryption-keys.png`, fullPage: true });
  }
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
