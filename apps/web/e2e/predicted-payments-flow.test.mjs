/**
 * Browser end-to-end test for predictive payment scheduling (AP-034): an owner with cash in the
 * bank, a customer who pays on time with an invoice open, and bills due over the next weeks sets a
 * balance to keep; Predicted payment dates pays an overdue bill today, one on its due date, one
 * after the customer's receipt, and says one is not covered; planning the dates adds them to the
 * payment schedule.
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

test('each open bill gets a payment date from the cash and the receipts expected', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Pooja Planner');
  await page.getByLabel('Email').fill(`e2e-predpay-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Payment Dates Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const fy = await must(call(`${B}/periods`));
  if (!fy.some((p) => p.startDate <= addDays(T, -130))) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(fy[0].startDate.slice(0, 4)) - 1 });
  await must(call(`${B}/journals`, { date: addDays(T, -130), post: true, memo: 'Capital', lines: [{ accountId: acc('1120'), debit: '50000' }, { accountId: acc('3100'), credit: '50000' }] }));
  const asha = await must(call(`${B}/contacts`, { name: 'Asha Traders', isCustomer: true }));
  const invoice = async (issueDate, amount) => (await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: asha.id, issueDate, dueDate: addDays(issueDate, 15), post: true, lines: [{ accountId: acc('4100'), quantity: '1', unitPrice: amount }] }))).id;
  for (let k = 0; k < 3; k++) {
    const issued = addDays(T, -60 - k * 20);
    const id = await invoice(issued, '10000.00');
    await must(call(`${B}/sales/payments`, { contactId: asha.id, date: addDays(issued, 15), bankAccountId: acc('1120'), amount: '10000.00', allocations: [{ documentId: id, amount: '10000.00' }] }));
  }
  await invoice(T, '50000.00');
  const bill = async (name, n, dueIn, amount) => {
    const x = await must(call(`${B}/contacts`, { name, isVendor: true }));
    await must(call(`${B}/contacts/${x.id}/bank-details`, { accountName: name, accountNumber: `50100${n}12345`, ifsc: 'HDFC0001234' }, 'PUT'));
    await must(call(`${B}/contacts/${x.id}/bank-details/verify`, { note: 'Checked against a cancelled cheque' }));
    return must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: x.id, issueDate: addDays(T, -40), dueDate: addDays(T, dueIn), post: true, lines: [{ accountId: acc('6600'), quantity: '1', unitPrice: amount }] }));
  };
  const oak = await bill('Oak Metals', 1, -20, '30000');
  const pine = await bill('Pine Paper', 2, 5, '40000');
  const elm = await bill('Elm Freight', 3, 10, '25000');
  const teak = await bill('Teak Works', 4, 12, '60000');
  consoleErrors.length = 0;

  await page.goto(`${base}/purchases/payment-schedule/predicted`);
  await page.getByLabel('Keep in the bank').fill('10000');
  await page.getByRole('button', { name: 'Work it out' }).click();
  const table = page.getByRole('table', { name: 'Suggested payment dates' });
  await table.getByText('Pay later, when cash comes in').waitFor();
  const rows = await table.locator('tbody tr').allInnerTexts();
  assert.equal(rows.length, 4);
  assert.match(rows[0], new RegExp(`${oak.number}[\\s\\S]*Oak Metals[\\s\\S]*Overdue: pay today[\\s\\S]*20 days overdue; the cash covers it today`));
  assert.match(rows[1], new RegExp(`${pine.number}[\\s\\S]*Pay on the due date`));
  assert.match(rows[2], new RegExp(`${elm.number}[\\s\\S]*Pay later, when cash comes in[\\s\\S]*5 days late[\\s\\S]*the largest ₹50,000\\.00 from Asha Traders`));
  assert.match(rows[3], new RegExp(`${teak.number}[\\s\\S]*Not covered in the period`));
  await page.getByText('Paid late', { exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predicted-payment-dates.png`, fullPage: true });

  await page.getByRole('button', { name: 'Plan these dates (3)' }).click();
  await page.getByRole('button', { name: /^Plan these dates/ }).waitFor({ state: 'detached' });
  assert.equal(await table.getByRole('button', { name: /^Plan / }).count(), 0);
  await page.getByRole('link', { name: 'Payment schedule', exact: true }).first().click();
  await page.waitForURL(/\/purchases\/payment-schedule$/);
  await page.getByText(elm.number).first().waitFor();
  assert.deepEqual(consoleErrors, []);
});
