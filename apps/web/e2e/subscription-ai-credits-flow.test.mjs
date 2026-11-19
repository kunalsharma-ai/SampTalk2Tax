/**
 * Browser end-to-end test for extra AI requests (SUBS-018): a platform administrator adds a pack
 * of AI requests under Platform admin → Plans, an organisation's owner chooses it under Usage,
 * pays on the gateway's page, and the requests show as bought, with a tax invoice. Real Next.js app → real API → real MongoDB → the real
 * Razorpay client code against a local stand-in (port 4557). The API must run with
 * PAYMENTS_RAZORPAY_API_URL=http://127.0.0.1:4557.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startPaymentsStandIn } from '../../../test-support/payments-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const SHOTS = process.env.SHOTS_DIR;
let browser;
let gateway;
let admin;
const consoleErrors = [];

async function register(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
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
  gateway = await startPaymentsStandIn(4557, { razorpayWebhook: { url: `${WEB}/api/webhooks/payments/razorpay`, secret: 'e2e-webhook-secret' } });
});
after(async () => {
  // Leave no gateway taking payments, and no pack on offer, for the other browser tests.
  if (admin) {
    await admin.evaluate(async () => {
      const packs = await fetch('/api/t2t/v1/admin/ai-credit-packs').then((r) => r.json());
      for (const p of packs.filter((x) => x.isActive)) await fetch(`/api/t2t/v1/admin/ai-credit-packs/${p.id}/active`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ active: false }) });
      await fetch('/api/t2t/v1/admin/payments/gateways/razorpay', { method: 'DELETE', headers: { 'x-t2t-csrf': '1' } });
    });
  }
  await browser?.close();
  await gateway?.close();
});

test('an owner buys a pack of AI requests and sees it under Usage', async () => {
  const tag = randomUUID().slice(0, 8);
  const adminEmail = `e2e-credits-admin-${tag}@example.test`;
  admin = await register('Credits Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });
  const keys = gateway.keys.RAZORPAY;
  const setup = await admin.evaluate(async (k) => {
    const put = (path, body) => fetch(`/api/t2t${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify(body) }).then((r) => r.status);
    // Packs from earlier runs stop being offered, so the one added below is the only one.
    const packs = await fetch('/api/t2t/v1/admin/ai-credit-packs').then((r) => r.json());
    for (const p of packs.filter((x) => x.isActive)) await fetch(`/api/t2t/v1/admin/ai-credit-packs/${p.id}/active`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ active: false }) });
    return [
      await put('/v1/admin/payments/profile', { legalName: 'Sampledge Technologies Pvt Ltd', address: 'Baner, Pune, Maharashtra 411045', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', email: 'billing@sampledge.test', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' }),
      await put('/v1/admin/payments/gateways/razorpay', { enabled: true, mode: 'TEST', currencies: ['INR'], keyId: k.keyId, secret: k.secret, webhookSecret: 'e2e-webhook-secret' }),
    ];
  }, keys);
  assert.deepEqual(setup, [200, 200]);

  // A pack of 1,000 requests offered.
  await admin.goto(`${WEB}/admin/plans`);
  const form = admin.locator('form[aria-label="New AI request pack"]');
  await form.getByLabel('Pack name').fill('1,000 AI requests');
  await form.getByLabel('Requests').fill('1000');
  await form.getByLabel('INR price').fill('799');
  await form.getByLabel('USD price').fill('12');
  await form.getByRole('button', { name: 'Add pack' }).click();
  const packs = admin.locator('[aria-label="AI request packs"]');
  await packs.getByRole('row').filter({ hasText: '1,000 AI requests' }).filter({ hasText: 'Offered' }).waitFor();
  if (SHOTS) await packs.screenshot({ path: `${SHOTS}/admin-ai-request-packs.png` });

  // An owner buys it under Usage.
  const owner = await register('Credits Owner', `e2e-credits-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Credit Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = owner.url();
  await owner.goto(`${orgUrl}/settings/usage`);
  const extra = owner.locator('[aria-label="Extra AI requests"]');
  await extra.getByTestId('credit-balance').getByText('extra requests left').waitFor();
  assert.match(await extra.getByTestId('credit-balance').innerText(), /^0/);
  const pack = extra.locator('[aria-label="Pack 1,000 AI requests"]');
  assert.match(await pack.innerText(), /₹799\.00 plus tax/);
  await pack.getByRole('button', { name: 'Choose' }).click();
  const total = extra.locator('[aria-label="Pack total"]');
  await total.getByText('Total').waitFor();
  assert.match(await total.innerText(), /Total\s+₹942\.82/);
  if (SHOTS) await extra.screenshot({ path: `${SHOTS}/extra-ai-requests-checkout.png` });
  await total.getByRole('button', { name: /Pay ₹942\.82/ }).click();
  await owner.waitForURL(/127\.0\.0\.1:4557\/pay\/plink_/);
  await owner.getByRole('button', { name: 'Pay (test)' }).click();
  await owner.waitForURL(/\/settings\/usage\?invoice=/);
  const done = owner.getByRole('status').filter({ hasText: 'Payment received' });
  await done.waitFor();
  await extra.getByTestId('credit-balance').getByText('1,000').waitFor();
  await extra.getByRole('row').filter({ hasText: '1,000 AI requests' }).filter({ hasText: '0 of 1,000' }).waitFor();
  if (SHOTS) await extra.screenshot({ path: `${SHOTS}/extra-ai-requests-bought.png` });

  // The tax invoice names the pack.
  await done.getByRole('link', { name: 'View the invoice' }).click();
  const inv = owner.locator('[aria-label="Invoice"]');
  await inv.getByText('Talk2Tax extra AI requests: 1,000 AI requests (1,000 requests)').waitFor();
  assert.match(await inv.innerText(), /Total\s+₹942\.82/);
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
