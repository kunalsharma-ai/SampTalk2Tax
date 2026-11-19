/**
 * Browser end-to-end test for encryption in transit (SEC-010): the production web app sends a
 * visitor who arrived over http:// to the https:// address, tells browsers on HTTPS to keep to
 * HTTPS, leaves localhost alone, and a platform administrator sees how each connection is
 * protected under Platform admin → System health. Real Next.js app → real API → real MongoDB.
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

test('http:// visitors are sent to https://, and HTTPS responses keep browsers on HTTPS', async () => {
  const plain = await fetch(`${WEB}/login?next=%2Fsettings`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'books.example.in' } });
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.get('location'), 'https://books.example.in/login?next=%2Fsettings');

  const secure = await fetch(`${WEB}/login`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'books.example.in' } });
  assert.equal(secure.status, 200);
  assert.equal(secure.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');

  // The container's own health check and a developer's machine are left alone.
  const local = await fetch(`${WEB}/login`, { redirect: 'manual' });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('strict-transport-security'), null);
});

test('a platform administrator sees how each connection is protected', async () => {
  const email = `e2e-transit-admin-${randomUUID().slice(0, 8)}@example.test`;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Transit Admin');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', email], { cwd: API_DIR, encoding: 'utf8' });

  await page.goto(`${WEB}/admin/system`);
  const card = page.getByRole('region', { name: 'Encryption in transit' });
  const table = card.getByRole('table', { name: 'Connections' });
  await table.waitFor();
  const text = await table.innerText();
  // This test server runs without HTTPS: the card says so instead of claiming otherwise.
  assert.match(text, /Browsers and apps to Talk2Tax\s+HTTP accepted \(HTTPS_ONLY is off\)/);
  assert.match(text, /This page was read over\s+HTTP/);
  assert.match(text, /API server to the database\s+Not encrypted/);
  assert.match(text, /Email sent by Talk2Tax\s+Encrypted when the mail server offers STARTTLS/);
  assert.match(text, /Webhooks and automations\s+http:\/\/ and private addresses allowed \(testing only\)/);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `${SHOTS}/encryption-in-transit.png` });
  }
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
