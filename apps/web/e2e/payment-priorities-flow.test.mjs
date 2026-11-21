/**
 * Browser end-to-end test for payment priorities (AP-030) and early-payment discount offers
 * (AP-029): an owner with ₹1,00,000 in the bank and verified vendors has a bill 40 days past due,
 * one due in 5 days and one due in 40 days; the page pays the first two now and suggests a
 * discount for the third; keeping ₹40,000 in the bank leaves the third short and withdraws the
 * offer. Real Next.js app → real API → real MongoDB.
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

test('bills are put in payment order against the cash, with discounts to ask for', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Pavan Payables');
  await page.getByLabel('Email').fill(`e2e-paypri-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Payables Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const orgId = base.split('/orgs/')[1];
  const B = `/v1/orgs/${orgId}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const fy = await must(call(`${B}/periods`));
  if (!fy.some((p) => p.startDate <= addDays(T, -90))) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(fy[0].startDate.slice(0, 4)) - 1 });
  await must(call(`${B}/journals`, { date: addDays(T, -80), post: true, memo: 'Capital', lines: [{ accountId: acc('1120'), debit: '100000' }, { accountId: acc('3100'), credit: '100000' }] }));
  const vendor = async (name, n) => {
    const x = await must(call(`${B}/contacts`, { name, isVendor: true }));
    await must(call(`${B}/contacts/${x.id}/bank-details`, { accountName: name, accountNumber: `50100${n}12345`, ifsc: 'HDFC0001234' }, 'PUT'));
    await must(call(`${B}/contacts/${x.id}/bank-details/verify`, { note: 'Checked against a cancelled cheque' }));
    return x;
  };
  const bill = (who, issueAgo, dueIn, amount) => must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: who.id, issueDate: addDays(T, -issueAgo), dueDate: addDays(T, dueIn), post: true, lines: [{ accountId: acc('6600'), quantity: '1', unitPrice: amount }] }));
  const oak = await bill(await vendor('Oak Metals', 1), 70, -40, '30000');
  const pine = await bill(await vendor('Pine Paper', 2), 20, 5, '20000');
  const elm = await bill(await vendor('Elm Freight', 3), 5, 40, '36500');

  await page.goto(`${base}/purchases/payment-priorities`);
  const table = page.getByRole('table', { name: 'Bills in payment order' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  assert.equal(await rows.count(), 3);
  const text = await rows.allInnerTexts();
  assert.match(text[0], new RegExp(`${oak.number}[\\s\\S]*Oak Metals[\\s\\S]*40 days past due[\\s\\S]*Pay now`));
  assert.match(text[1], new RegExp(`${pine.number}[\\s\\S]*Pay now`));
  assert.match(text[2], new RegExp(`${elm.number}[\\s\\S]*Pay on the due date`));
  const offers = page.getByRole('table', { name: 'Early-payment discounts to ask for' });
  // 36,500 × 12% × 40 / 365 = 480.00.
  await offers.getByText('₹480.00').waitFor();
  await offers.getByText('₹36,020.00').waitFor();
  await rows.nth(0).getByText('/ 100').click();
  await rows.nth(0).getByText(/50\/50 Urgency: 40 days past due/).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/payment-priorities.png`, fullPage: true });

  await page.getByLabel('Keep in the bank').fill('40000');
  await page.getByRole('button', { name: 'Work it out' }).click();
  await rows.nth(1).getByText('Cash will not cover it').or(rows.nth(2).getByText('Cash will not cover it')).first().waitFor();
  await page.getByText('The cash does not cover every bill, so paying any early is not suggested.').waitFor();
  assert.deepEqual(consoleErrors, []);
});
