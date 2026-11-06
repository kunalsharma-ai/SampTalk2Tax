/**
 * Browser end-to-end test for paying a subscription online: a platform administrator sets up
 * the seller details and Razorpay in Platform admin → Payments, an organisation's owner pays for
 * Growth on the gateway's page, the signed webhook reaches the API through the web app, and the
 * owner comes back to a paid tax invoice. Real Next.js app → real API → real PostgreSQL → the
 * real Razorpay client code against a local stand-in for Razorpay's API (port 4557). The API must
 * run with PAYMENTS_RAZORPAY_API_URL=http://127.0.0.1:4557.
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

test('an owner pays for a plan online and gets a tax invoice', async () => {
  const tag = randomUUID().slice(0, 8);
  const adminEmail = `e2e-pay-admin-${tag}@example.test`;
  admin = await register('Payments Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });

  // Seller details and Razorpay, set up in the app.
  await admin.goto(`${WEB}/admin/payments`);
  const seller = admin.locator('[aria-label="Seller details"]');
  await seller.getByLabel('Legal name').fill('Sampledge Technologies Pvt Ltd');
  await seller.getByLabel('Address').fill('Baner, Pune, Maharashtra 411045');
  await seller.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
  await seller.getByLabel('Billing email').fill('billing@sampledge.test');
  await seller.getByRole('button', { name: 'Save seller details' }).click();
  await seller.getByRole('status').getByText('Saved').waitFor();
  const rzp = admin.locator('[aria-label="Razorpay"]');
  await rzp.getByLabel('Key id (rzp_…)').fill(gateway.keys.RAZORPAY.keyId);
  await rzp.getByLabel('Key secret').fill(gateway.keys.RAZORPAY.secret);
  await rzp.getByLabel('Webhook secret').fill('e2e-webhook-secret');
  await rzp.getByLabel('INR').check();
  await rzp.getByLabel('Take subscription payments through Razorpay').check();
  await rzp.getByRole('button', { name: 'Save' }).click();
  await rzp.getByText('Taking payments').waitFor();
  assert.match(await rzp.innerText(), /Stored: …cret/);
  await rzp.getByRole('button', { name: 'Test connection' }).click();
  await rzp.getByRole('status').getByText('Connected to Razorpay (test key)').waitFor();
  assert.equal(await admin.getByTestId('webhook-url-RAZORPAY').innerText(), 'http://localhost:3000/api/webhooks/payments/razorpay');

  // An owner chooses Growth and sees the price with GST.
  const owner = await register('Paying Owner', `e2e-pay-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Paying Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Subscription', exact: true }).click();
  await owner.locator('section[aria-label="Growth plan"]').getByRole('button', { name: 'Choose Growth' }).click();
  const checkout = owner.locator('[aria-label="Checkout"]');
  await checkout.getByText('starts when your trial ends').waitFor();
  const amount = await checkout.getByRole('table', { name: 'Amount' }).innerText();
  assert.match(amount, /CGST 9%\s+₹134\.91/);
  assert.match(amount, /Total\s+₹1,768\.82/);

  // Pays on the gateway's page and comes back.
  await checkout.getByRole('button', { name: /Pay ₹1,768\.82 now/ }).click();
  await owner.waitForURL(/127\.0\.0\.1:4557\/pay\/plink_/);
  await owner.getByText('INR 1768.82').waitFor();
  await owner.getByRole('button', { name: 'Pay (test)' }).click();
  await owner.waitForURL(/\/settings\/subscription\?invoice=/);
  assert.equal(gateway.sent.at(-1).status, 200, `webhook answer: ${JSON.stringify(gateway.sent.at(-1))}`);
  const done = owner.getByRole('status').filter({ hasText: 'Payment received' });
  await done.waitFor();
  assert.match(await done.innerText(), /Tax invoice T2T\/\d{2}-\d{2}\/\d{5} for ₹1,768\.82/);
  await owner.locator('[aria-label="Current plan"]').getByText('Growth plan').waitFor();

  // The tax invoice.
  await done.getByRole('link', { name: 'View the invoice' }).click();
  const inv = owner.locator('[aria-label="Invoice"]');
  await inv.getByRole('heading', { name: 'Tax invoice' }).waitFor();
  const text = await inv.innerText();
  assert.match(text, /Sampledge Technologies Pvt Ltd/);
  assert.match(text, /GSTIN 27AAPFU0939F1ZV/);
  assert.match(text, /SGST at 9%\s+₹134\.91/);
  assert.match(text, /Paid online \(razorpay\), reference pay_/);

  // The administrator sees it paid, and the valid notice.
  await admin.goto(`${WEB}/admin/invoices`);
  const row = admin.locator('[aria-label="Invoices"]').getByRole('row', { name: new RegExp(`E2E Paying Traders ${tag}`) });
  await row.getByText('Paid').first().waitFor();
  await admin.locator('[aria-label="Gateway notices"]').getByText(/Paid: T2T\//).first().waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
