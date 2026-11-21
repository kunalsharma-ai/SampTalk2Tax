/**
 * Browser end-to-end test for payment fraud indicators (AP-028): an owner changes a vendor's bank
 * details and puts the vendor's bill in a payment batch straight away, and pays another vendor the
 * same amount twice in three days; Payment fraud checks shows the batch first as high with the
 * unverified change and the same person, the duplicates next, filters by level, and opens the batch.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('vendor payments with warning signs are listed, most serious first', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Farah Fraudwatch');
  await page.getByLabel('Email').fill(`e2e-fraud-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Fraud Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const orgId = base.split('/orgs/')[1];
  const B = `/v1/orgs/${orgId}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const vendor = (name) => must(call(`${B}/contacts`, { name, isVendor: true }));
  const bill = (who, amount) => must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: who.id, issueDate: addDays(T, -5), post: true, lines: [{ accountId: acc('6600'), quantity: '1', unitPrice: amount }] }));
  const swift = await vendor('Swift Logistics');
  const maple = await vendor('Maple Paper');
  await must(call(`/v1/orgs/${orgId}/contacts/${swift.id}/bank-details`, { accountName: 'Swift Logistics', accountNumber: '9988776655', ifsc: 'HDFC0001234' }, 'PUT'));
  const sb = await bill(swift, '42000');
  const batch = await must(call(`${B}/purchases/payment-batches`, { bankAccountId: acc('1120'), paymentDate: T, items: [{ documentId: sb.id }] }));
  for (const off of [-4, -1]) {
    const b = await bill(maple, '5000');
    await must(call(`${B}/purchases/payments`, { contactId: maple.id, date: addDays(T, off), bankAccountId: acc('1120'), amount: '5000.00', allocations: [{ documentId: b.id, amount: '5000.00' }] }));
  }

  await page.goto(`${base}/purchases/payment-fraud`);
  const table = page.getByRole('table', { name: 'Payments with warning signs' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  assert.equal(await rows.count(), 3);
  const text = await rows.allInnerTexts();
  assert.match(text[0], /Swift Logistics/);
  assert.match(text[0], /Waiting in a batch \(draft\)/);
  assert.match(text[0], /Bank details changed on the day of the payment and not verified since/);
  assert.match(text[0], /The person who changed the bank details also made this payment/);
  assert.match(text[0], /The vendor was added on the day of the payment/);
  for (const t of text.slice(1)) {
    assert.match(t, /Maple Paper/);
    assert.match(t, /Another payment of ₹5,000\.00 to this vendor within 7 days/);
  }
  assert.doesNotMatch(await page.content(), /9988776655/);
  await page.getByText('In open batches').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/payment-fraud.png`, fullPage: true });

  await page.getByLabel('Level').selectOption('HIGH');
  assert.equal(await rows.count(), 3);
  await page.getByLabel('Level').selectOption('LOW');
  await page.getByText('No warning signs').waitFor();
  await page.getByLabel('Level').selectOption('ALL');
  await rows.first().getByRole('link', { name: 'Batch 1' }).click();
  await page.waitForURL(new RegExp(`/purchases/payment-batches/${batch.id}`));
  assert.deepEqual(consoleErrors, []);
});
