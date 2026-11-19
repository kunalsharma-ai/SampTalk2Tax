/**
 * Browser end-to-end test for subscription coupons (SUBS-024): a platform administrator creates a
 * coupon in Platform admin → Coupons, an organisation's owner enters it at checkout, sees it taken
 * off before GST, pays on the gateway's page, and the coupon shows on the subscription, the tax
 * invoice and the administrator's list. Real Next.js app → real API → real MongoDB → the real
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
  // Leave no gateway taking payments for the other browser tests.
  if (admin) await admin.evaluate(async () => { await fetch('/api/t2t/v1/admin/payments/gateways/razorpay', { method: 'DELETE', headers: { 'x-t2t-csrf': '1' } }); });
  await browser?.close();
  await gateway?.close();
});

test('an administrator creates a coupon and an owner pays less with it', async () => {
  const tag = randomUUID().slice(0, 8);
  const code = `E2E-${tag.toUpperCase()}`;
  const adminEmail = `e2e-coupon-admin-${tag}@example.test`;
  admin = await register('Coupon Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });
  // Seller details and Razorpay (their own screens are covered by the payments browser test).
  const keys = gateway.keys.RAZORPAY;
  const setup = await admin.evaluate(async (k) => {
    const put = (path, body) => fetch(`/api/t2t${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify(body) }).then((r) => r.status);
    return [
      await put('/v1/admin/payments/profile', { legalName: 'Sampledge Technologies Pvt Ltd', address: 'Baner, Pune, Maharashtra 411045', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', email: 'billing@sampledge.test', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' }),
      await put('/v1/admin/payments/gateways/razorpay', { enabled: true, mode: 'TEST', currencies: ['INR'], keyId: k.keyId, secret: k.secret, webhookSecret: 'e2e-webhook-secret' }),
    ];
  }, keys);
  assert.deepEqual(setup, [200, 200]);

  // The coupon: 20% off the first 3 payments, Growth only.
  await admin.goto(`${WEB}/admin/coupons`);
  const form = admin.locator('[aria-label="New coupon"]');
  await form.getByLabel('Code').fill(code);
  await form.getByLabel('Description (optional)').fill('Launch offer');
  await form.getByLabel('Percentage off').fill('20');
  await form.getByLabel('Payments it takes money off').selectOption('3');
  await form.getByLabel('Growth').check();
  await form.getByRole('button', { name: 'Create coupon' }).click();
  const list = admin.locator('[aria-label="Coupons"]');
  const row = list.getByRole('row', { name: new RegExp(code) });
  await row.getByText('20% off the first 3 payments').waitFor();
  await row.getByText('On offer').waitFor();
  // The same code again is refused.
  await form.getByLabel('Code').fill(code);
  await form.getByLabel('Percentage off').fill('10');
  await form.getByRole('button', { name: 'Create coupon' }).click();
  await form.getByText(`A coupon with the code ${code} exists already`).waitFor();

  // An owner enters it at checkout.
  const owner = await register('Coupon Owner', `e2e-coupon-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Coupon Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Subscription', exact: true }).click();
  await owner.locator('section[aria-label="Professional plan"]').getByRole('button', { name: 'Choose Professional' }).click();
  const checkout = owner.locator('[aria-label="Checkout"]');
  await checkout.getByLabel('Coupon code').fill(code.toLowerCase());
  await checkout.getByRole('button', { name: 'Apply' }).click();
  await checkout.getByText('This coupon is for the GROWTH plan').waitFor();
  await owner.locator('section[aria-label="Growth plan"]').getByRole('button', { name: 'Choose Growth' }).click();
  const amount = checkout.getByRole('table', { name: 'Amount' });
  await amount.getByText(`Coupon ${code}`).waitFor();
  const text = await amount.innerText();
  assert.match(text, /Subscription\s+₹1,499\.00/);
  assert.match(text, /−₹299\.80/);
  assert.match(text, /Taxable value\s+₹1,199\.20/);
  assert.match(text, /CGST 9%\s+₹107\.93/);
  assert.match(text, /Total\s+₹1,415\.06/);
  if (SHOTS) await checkout.screenshot({ path: `${SHOTS}/coupon-checkout.png` });

  // Pays the lower amount on the gateway's page.
  await checkout.getByRole('button', { name: /Pay ₹1,415\.06 now/ }).click();
  await owner.waitForURL(/127\.0\.0\.1:4557\/pay\/plink_/);
  await owner.getByText('INR 1415.06').waitFor();
  await owner.getByRole('button', { name: 'Pay (test)' }).click();
  await owner.waitForURL(/\/settings\/subscription\?invoice=/);
  const done = owner.getByRole('status').filter({ hasText: 'Payment received' });
  await done.waitFor();
  await owner.getByTestId('subscription-coupon').getByText('20% off the first 3 payments (Launch offer): used on 1 payment, 2 more to come.').waitFor();
  if (SHOTS) await owner.locator('[aria-label="Current plan"]').screenshot({ path: `${SHOTS}/coupon-current-plan.png` });

  // The tax invoice shows the coupon before tax.
  await done.getByRole('link', { name: 'View the invoice' }).click();
  const inv = owner.locator('[aria-label="Invoice"]');
  await inv.getByRole('heading', { name: 'Tax invoice' }).waitFor();
  const invText = await inv.innerText();
  assert.match(invText, new RegExp(`Less: coupon ${code}\\s+−₹299\\.80`));
  assert.match(invText, /Taxable value\s+₹1,199\.20/);
  assert.match(invText, /Total\s+₹1,415\.06/);
  if (SHOTS) await inv.screenshot({ path: `${SHOTS}/coupon-invoice.png` });

  // The administrator sees who used it and what it took off, and switches it off.
  await admin.reload();
  await row.getByText(`E2E Coupon Traders ${tag}: 1 payment, ₹299.80, 2 left`).waitFor();
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/admin-coupons.png`, fullPage: true });
  await row.getByRole('button', { name: 'Switch off' }).click();
  await row.getByText('Switched off').waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
