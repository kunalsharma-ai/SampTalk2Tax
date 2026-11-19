/**
 * Browser end-to-end test for add-on modules (SUBS-017): a platform administrator prices Payroll
 * as an add-on under Platform admin → Plans, an organisation's owner adds it to Growth at
 * checkout, pays on the gateway's page, and the add-on shows on the subscription and the tax
 * invoice. Real Next.js app → real API → real MongoDB → the real
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
  // Leave no gateway taking payments, and no add-on on offer, for the other browser tests.
  if (admin) {
    await admin.evaluate(async () => {
      const addOns = await fetch('/api/t2t/v1/admin/add-ons').then((r) => r.json());
      for (const a of addOns.filter((x) => x.prices && x.isActive)) await fetch(`/api/t2t/v1/admin/add-ons/${a.feature.toLowerCase()}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ prices: a.prices, isActive: false }) });
      await fetch('/api/t2t/v1/admin/payments/gateways/razorpay', { method: 'DELETE', headers: { 'x-t2t-csrf': '1' } });
    });
  }
  await browser?.close();
  await gateway?.close();
});

test('an owner adds Payroll to Growth and pays for both', async () => {
  const tag = randomUUID().slice(0, 8);
  const adminEmail = `e2e-addon-admin-${tag}@example.test`;
  admin = await register('Add-on Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });
  const keys = gateway.keys.RAZORPAY;
  const setup = await admin.evaluate(async (k) => {
    const put = (path, body) => fetch(`/api/t2t${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify(body) }).then((r) => r.status);
    return [
      await put('/v1/admin/payments/profile', { legalName: 'Sampledge Technologies Pvt Ltd', address: 'Baner, Pune, Maharashtra 411045', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', email: 'billing@sampledge.test', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' }),
      await put('/v1/admin/payments/gateways/razorpay', { enabled: true, mode: 'TEST', currencies: ['INR'], keyId: k.keyId, secret: k.secret, webhookSecret: 'e2e-webhook-secret' }),
    ];
  }, keys);
  assert.deepEqual(setup, [200, 200]);

  // Payroll priced as an add-on.
  await admin.goto(`${WEB}/admin/plans`);
  const row = admin.locator('[aria-label="Payroll add-on"]');
  await row.getByLabel('INR monthly').fill('999');
  await row.getByLabel('INR annual').fill('9990');
  await row.getByLabel('USD monthly').fill('15');
  await row.getByLabel('USD annual').fill('150');
  await row.getByLabel('Offered').check();
  await row.getByRole('button', { name: 'Save' }).click();
  await row.getByRole('status').getByText('Saved').waitFor();
  await row.getByText(/^Offered ·/).waitFor();
  if (SHOTS) await admin.locator('[aria-label="Add-on modules"]').screenshot({ path: `${SHOTS}/admin-add-ons.png` });

  // An owner adds it to Growth.
  const owner = await register('Add-on Owner', `e2e-addon-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Add-on Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Subscription', exact: true }).click();
  await owner.locator('section[aria-label="Growth plan"]').getByRole('button', { name: 'Choose Growth' }).click();
  const checkout = owner.locator('[aria-label="Checkout"]');
  await checkout.getByLabel(/Payroll/).check();
  const amount = checkout.getByRole('table', { name: 'Amount' });
  await amount.getByText('Growth with Payroll (+999.00)').waitFor();
  const text = await amount.innerText();
  assert.match(text, /₹2,498\.00/);
  assert.match(text, /Total\s+₹2,947\.64/);
  if (SHOTS) await checkout.screenshot({ path: `${SHOTS}/add-on-checkout.png` });
  await checkout.getByRole('button', { name: /Pay ₹2,947\.64 now/ }).click();
  await owner.waitForURL(/127\.0\.0\.1:4557\/pay\/plink_/);
  await owner.getByRole('button', { name: 'Pay (test)' }).click();
  await owner.waitForURL(/\/settings\/subscription\?invoice=/);
  const done = owner.getByRole('status').filter({ hasText: 'Payment received' });
  await done.waitFor();
  await owner.getByTestId('subscription-add-ons').getByText('Payroll').waitFor();

  // The tax invoice names the add-on.
  await done.getByRole('link', { name: 'View the invoice' }).click();
  const inv = owner.locator('[aria-label="Invoice"]');
  await inv.getByText('With add-on modules: Payroll (999.00 INR a month)').waitFor();
  assert.match(await inv.innerText(), /Total\s+₹2,947\.64/);
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
