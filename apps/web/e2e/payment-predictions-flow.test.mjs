/**
 * Browser end-to-end test for payment-delay predictions (AR-033): an owner records invoices and
 * receipts for a punctual customer and a slow one, then opens Payment predictions: the slow
 * customer's past-due invoice comes first as very late, the punctual customer's new invoice is
 * on time, the reasons say why, filtering by band works, and accuracy is checked on paid invoices.
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

test('open invoices are scored by how each customer has paid, riskiest first', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Priya Predict');
  await page.getByLabel('Email').fill(`e2e-predict-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Predict Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const fy = await must(call(`${B}/periods`));
  if (!fy.some((p) => p.startDate <= addDays(T, -200))) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(fy[0].startDate.slice(0, 4)) - 1 });
  const prompt = await must(call(`${B}/contacts`, { name: 'Punctual Paints', isCustomer: true }));
  const slow = await must(call(`${B}/contacts`, { name: 'Slowpay Steel', isCustomer: true }));
  const invoice = (who, issueDate, amount, dueIn = 30) => must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: who.id, issueDate, dueDate: addDays(issueDate, dueIn), post: true, lines: [{ accountId: acc('4100'), quantity: '1', unitPrice: amount }] }));
  const receipt = (who, date, doc, amount) => must(call(`${B}/sales/payments`, { contactId: who.id, date, bankAccountId: acc('1120'), amount, allocations: [{ documentId: doc.id, amount }] }));
  for (let k = 0; k < 6; k++) {
    const issued = addDays(T, -60 - k * 20);
    await receipt(prompt, addDays(issued, 30), await invoice(prompt, issued, '10000'), '10000.00');
  }
  for (let k = 0; k < 3; k++) {
    const issued = addDays(T, -110 - k * 30);
    await receipt(slow, addDays(issued, 70), await invoice(slow, issued, '20000'), '20000.00');
  }
  const late = await invoice(slow, addDays(T, -65), '30000');
  const fresh = await invoice(prompt, T, '12000', 20);

  await page.goto(`${base}/sales/payment-predictions`);
  const table = page.getByRole('table', { name: 'Predicted payments' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  assert.equal(await rows.count(), 2);
  const first = await rows.nth(0).innerText();
  assert.match(first, new RegExp(late.number));
  assert.match(first, /Slowpay Steel/);
  assert.match(first, /Very late · 100%/);
  assert.match(first, /35 days past due/);
  assert.match(first, /Paid 3 invoices 40 days late on average/);
  const second = await rows.nth(1).innerText();
  assert.match(second, new RegExp(fresh.number));
  assert.match(second, /On time/);
  assert.match(second, /Paid 6 invoices on time on average/);
  await page.getByText('Invoices checked').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/payment-predictions.png`, fullPage: true });

  await page.getByLabel('Show').selectOption('VERY_LATE');
  assert.equal(await rows.count(), 1);
  await rows.first().getByText('Slowpay Steel').waitFor();
  await rows.first().getByRole('link', { name: late.number }).click();
  await page.waitForURL(new RegExp(`/sales/invoices/${late.id}`));
  assert.deepEqual(consoleErrors, []);
});
