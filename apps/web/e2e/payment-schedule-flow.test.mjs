/**
 * Browser end-to-end test for payment scheduling (AP-007): from a posted bill, Plan payment… opens
 * the schedule with the bill's plan dialog; part of the bill is planned for a date; Plan the rest
 * plans the other bills for their due dates; the weekly cash table flags the week that overdraws;
 * Prepare batch takes the bills planned up to a date into a new payment batch with their planned
 * amounts, saved as PB-0001.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
let browser, page;
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
});
after(async () => browser?.close());

test('bills are planned for payment, checked against the cash, and batched from the plan', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Schedule Owner');
  await page.getByLabel('Email').fill(`e2e-payment-schedule-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Payment Schedule Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  assert.equal((await call(`${B}/journals`, { date: addDays(T, -10), post: true, memo: 'Capital', lines: [{ accountId: acc['1120'], debit: '40000.00' }, { accountId: acc['3100'], credit: '40000.00' }] })).status, 201);
  const vendor = (await call(`${B}/contacts`, { name: 'Cedar Hardware', isVendor: true })).body;
  const bill = async (amount, due) => (await call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: T, dueDate: due, post: true, lines: [{ accountId: acc['6600'], quantity: '1', unitPrice: amount }] })).body;
  const b1 = await bill('30000', addDays(T, 3));
  const b2 = await bill('12000', addDays(T, 4));
  const b3 = await bill('50000', addDays(T, 40));

  // Plan part of the first bill from its page.
  await page.goto(`${O}/purchases/bills/${b1.id}`);
  await page.getByRole('link', { name: 'Plan payment…' }).click();
  await page.waitForURL(/payment-schedule\?plan=/);
  const dialog = page.getByRole('dialog', { name: `Plan payment of ${b1.number}` });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Pay on').inputValue(), addDays(T, 3));
  await dialog.getByLabel('Pay on').fill(addDays(T, 2));
  await dialog.getByLabel(/^Amount/).fill('20000');
  await dialog.getByLabel('Note').fill('Rest after the dispute is settled');
  await dialog.getByRole('button', { name: 'Save plan' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const table = page.getByRole('table', { name: 'Bills to pay' });
  await table.getByRole('row', { name: new RegExp(`${b1.number}.*On time.*20,000\\.00`) }).waitFor();
  await table.getByText('Rest after the dispute is settled').waitFor();
  await table.getByRole('row', { name: new RegExp(`${b3.number}.*Not planned`) }).waitFor();

  // Plan the rest for their due dates; the 50,000 bill overdraws its week.
  await page.getByRole('button', { name: 'Plan the rest on their due dates' }).click();
  await page.getByText('2 bills planned').waitFor();
  await table.getByRole('row', { name: new RegExp(`${b3.number}.*On time.*50,000\\.00`) }).waitFor();
  const weeks = page.getByRole('table', { name: 'Cash by week' });
  await weeks.getByText('Short').first().waitFor();
  await weeks.getByText(/-₹?42,000\.00|−₹?42,000\.00|-42,000\.00/).first().waitFor();

  // Prepare a batch from the bills planned in the next six days.
  await page.getByLabel('Bills planned up to').fill(addDays(T, 6));
  await page.getByRole('link', { name: 'Prepare batch (2)' }).click();
  await page.waitForURL(/payment-batches\/new\?plannedUpTo=/);
  await page.getByLabel(`Pay ${b1.number}`).waitFor();
  assert.equal(await page.getByLabel(`Pay ${b1.number}`).isChecked(), true);
  assert.equal(await page.getByLabel(`Pay ${b2.number}`).isChecked(), true);
  assert.equal(await page.getByLabel(`Pay ${b3.number}`).isChecked(), false);
  assert.equal(await page.getByLabel(`Amount for ${b1.number}`).inputValue(), '20000.00');
  await page.getByRole('button', { name: 'Save batch' }).click();
  await page.getByRole('heading', { name: 'Payment batch PB-0001' }).waitFor();
  await page.getByText(/32,000\.00/).first().waitFor();

  // The schedule shows which batch each bill is in.
  await page.goto(`${O}/purchases/payment-schedule`);
  await table.getByRole('row', { name: new RegExp(`${b2.number}.*In PB-0001`) }).waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
