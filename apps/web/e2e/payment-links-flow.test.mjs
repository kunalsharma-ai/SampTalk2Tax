/**
 * Browser end-to-end test for payment links (AR-018): an owner sets up the organisation's own
 * Razorpay account in Settings → Payment gateways, makes a payment link on a posted invoice, the
 * customer pays on the gateway's page and lands on the thank-you page, the signed notice reaches
 * the API through the web app, and the invoice shows paid with the receipt the link recorded.
 * Real Next.js app → real API → real PostgreSQL → the real Razorpay client code against a local
 * stand-in for Razorpay's API (port 4557). The API must run with PAYMENTS_RAZORPAY_API_URL=http://127.0.0.1:4557.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startPaymentsStandIn } from '../../../test-support/payments-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const WH = 'e2e-links-webhook-secret';
let browser, page, gateway;
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
  gateway = await startPaymentsStandIn(4557);
});
after(async () => {
  await browser?.close();
  await gateway?.close();
});

test('a customer pays an invoice through a payment link and the invoice is settled', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Links Owner');
  await page.getByLabel('Email').fill(`e2e-links-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Link Consultants');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  gateway.webhooks.RAZORPAY = { url: `${WEB}/api/webhooks/collect/${orgId}/razorpay`, secret: WH };
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Kapoor Retail', email: 'accounts@kapoor.test', isCustomer: true })).body;
  const d = (await call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, dueDate: T, lines: [{ accountId: acc['4100'], description: 'Consulting', quantity: '1', unitPrice: '12500' }] })).body;
  const invoice = (await call(`${B}/sales/documents/${d.id}/post`, {})).body;

  // Without a gateway the invoice says where to set one up.
  await page.goto(`${O}/sales/invoices/${invoice.id}`);
  const panel = page.locator('[aria-label="Payment links"]');
  await panel.getByText('No payment gateway takes INR yet').waitFor();
  await panel.getByRole('link', { name: 'Set up Razorpay or Stripe' }).click();

  // The organisation's own Razorpay account.
  await page.waitForURL(/\/settings\/payment-gateways$/);
  const rzp = page.locator('[aria-label="Razorpay"]');
  await rzp.getByLabel('Key id (rzp_…)').fill(gateway.keys.RAZORPAY.keyId);
  await rzp.getByLabel('Key secret').fill(gateway.keys.RAZORPAY.secret);
  await rzp.getByLabel('Webhook secret').fill(WH);
  await rzp.getByLabel('INR').check();
  await rzp.getByLabel('Paid out to').selectOption(acc['1120']);
  await rzp.getByRole('button', { name: 'Save' }).click();
  await rzp.getByText('Taking payments').waitFor();
  assert.match(await rzp.innerText(), /Stored: …cret/);
  await rzp.getByRole('button', { name: 'Test connection' }).click();
  await rzp.getByRole('status').getByText('Connected to Razorpay (test key)').waitFor();
  assert.equal(await page.getByTestId('webhook-url-RAZORPAY').innerText(), `http://localhost:3000/api/webhooks/collect/${orgId}/razorpay`);

  // A link for what is owed.
  await page.goto(`${O}/sales/invoices/${invoice.id}`);
  await panel.getByText('Razorpay · test mode').waitFor();
  await panel.getByRole('button', { name: 'Make payment link' }).click();
  const row = panel.getByRole('row', { name: /PL-0001/ });
  await row.getByText('Open').first().waitFor();
  assert.match(await row.innerText(), /₹12,500\.00/);
  const url = await row.getByRole('link', { name: 'Open' }).getAttribute('href');
  assert.match(url, /127\.0\.0\.1:4557\/pay\/plink_/);
  assert.equal(await panel.getByRole('button', { name: 'Make payment link' }).count(), 0);

  // The customer pays on the gateway's page and lands on the thank-you page.
  const customerPage = await browser.newPage();
  await customerPage.goto(url);
  await customerPage.getByText('INR 12500.00').waitFor();
  await customerPage.getByRole('button', { name: 'Pay (test)' }).click();
  await customerPage.waitForURL(/\/paid\?ref=PL-0001/);
  await customerPage.getByRole('heading', { name: 'Thank you for your payment' }).waitFor();
  assert.match(await customerPage.innerText('main'), /Reference PL-0001/);
  assert.equal(gateway.sent.at(-1).status, 200, `webhook answer: ${JSON.stringify(gateway.sent.at(-1))}`);
  await customerPage.close();

  // The invoice is paid by the receipt the link recorded.
  await page.reload();
  await row.getByText('Paid').first().waitFor();
  assert.match(await row.innerText(), /Receipt RCPT-/);
  await page.getByText('Still due').locator('..').getByText('₹0.00').waitFor();
  await row.getByRole('link', { name: /RCPT-/ }).click();
  await page.waitForURL(/\/sales\/receipts\//);
  await page.getByText(/Razorpay payment link PL-0001/).first().waitFor();

  // The list and the notice.
  await page.goto(`${O}/sales/payment-links`);
  await page.getByRole('row', { name: /PL-0001/ }).getByText('Paid').waitFor();
  await page.goto(`${O}/settings/payment-gateways`);
  await page.locator('[aria-label="Recent notices"]').getByText(/Paid: PL-0001, receipt RCPT-/).waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
