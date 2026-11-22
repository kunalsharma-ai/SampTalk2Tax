/**
 * Browser end-to-end test for receipt-to-transaction matching (EXP-019): a bank statement with
 * card and UPI spending is imported; one receipt is added on the page with its PDF, two more come
 * in through the API; the page suggests the bank line for each, matches the sure ones in one go,
 * and lists the payment still without a receipt. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const PDF = (t) => `%PDF-1.4\n% ${t}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
let browser, page;
const consoleErrors = [];

async function call(path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };
const upload = (path, text) => page.evaluate(async ([p, t]) => (await fetch(`/api/t2t${p}`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t2t-csrf': '1' }, body: new TextEncoder().encode(t) })).status, [path, text]);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('Receipt matching suggests the bank line, matches the sure ones and shows what has no receipt', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Rhea Receipts');
  await page.getByLabel('Email').fill(`e2e-receipts-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Receipt Matching Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const csv = [
    'Date,Narration,Ref,Amount',
    `${dmy(addDays(T, -5))},POS 4412 BLUE TOKAI MUMBAI,,-1180.00`,
    `${dmy(addDays(T, -4))},UPI DR 99881 CITY CABS,,-650.00`,
    `${dmy(addDays(T, -3))},UPI DR 7766 PRINT HUB,U1,-2500.00`,
    `${dmy(addDays(T, -2))},NEFT CR CUSTOMER,,5000.00`,
    `${dmy(addDays(T, -1))},POS OFFICE MART,,-999.00`,
  ].join('\n');
  await must(call(`${B}/banking/accounts/${acc['1120']}/imports`, { fileName: 'nov.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }));
  for (const [merchant, date, amount] of [['City Cabs', addDays(T, -4), '650.00'], ['Print Hub', addDays(T, -7), '2500.00']]) {
    const r = await must(call(`${B}/expense-receipts`, { merchant, date, amount }));
    assert.equal(await upload(`${B}/attachments?entityType=EXPENSE_RECEIPT&entityId=${r.id}&fileName=${encodeURIComponent(merchant)}.pdf`, PDF(merchant)), 201);
  }
  consoleErrors.length = 0;

  // Add a receipt on the page and attach its file.
  await page.goto(`${base}/expenses/receipts`);
  await page.getByRole('heading', { name: 'Receipt matching' }).waitFor();
  const form = page.getByRole('region', { name: 'Add a receipt' });
  await form.getByLabel('Merchant').fill('Blue Tokai Coffee');
  await form.getByLabel('Date on the receipt').fill(addDays(T, -6));
  await form.getByLabel(/^Amount/).fill('1180');
  await form.getByRole('button', { name: 'Add receipt' }).click();
  await page.waitForURL(/\/expenses\/receipts\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: /RC-003: Blue Tokai Coffee/ }).waitFor();
  const paid = page.getByRole('region', { name: 'Bank line paid' });
  assert.match(await paid.innerText(), /Sure[\s\S]*POS 4412 BLUE TOKAI MUMBAI[\s\S]*Same amount[\s\S]*1 day apart[\s\S]*"BLUE" in the bank narration/);
  assert.ok(await paid.getByRole('button', { name: 'Attach the file first' }).isDisabled());
  await page.getByLabel('Attach files').setInputFiles({ name: 'blue-tokai.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF('coffee')) });
  await page.getByRole('list', { name: 'Attached files' }).getByText('blue-tokai.pdf').waitFor();
  await paid.getByRole('button', { name: 'Match to this line' }).waitFor();

  // The list: two sure suggestions (Blue Tokai and City Cabs), Print Hub only possible (4 days apart, no name in the narration).
  await page.getByRole('link', { name: 'All receipts' }).click();
  const table = page.getByRole('table', { name: 'Uploaded receipts' });
  await table.waitFor();
  assert.match(await table.getByRole('row').filter({ hasText: 'City Cabs' }).innerText(), /Not matched[\s\S]*Sure[\s\S]*UPI DR 99881 CITY CABS/);
  assert.match(await table.getByRole('row').filter({ hasText: 'Print Hub' }).innerText(), /Likely[\s\S]*UPI DR 7766 PRINT HUB[\s\S]*4 days apart/);
  const missing = page.getByRole('table', { name: 'Bank spending without a receipt' });
  assert.match(await missing.getByRole('row').filter({ hasText: 'POS OFFICE MART' }).innerText(), /Ask who paid for the receipt/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/receipt-matching.png`, fullPage: true });

  await page.getByRole('button', { name: 'Match 2 sure ones' }).click();
  await page.getByText('2 receipts matched').waitFor();
  await table.getByRole('row').filter({ hasText: 'Blue Tokai Coffee' }).getByText('Matched', { exact: true }).waitFor();
  await table.getByRole('row').filter({ hasText: 'City Cabs' }).getByText('Matched', { exact: true }).waitFor();
  // Print Hub by hand.
  await table.getByRole('button', { name: 'Match RC-002' }).click();
  await table.getByRole('row').filter({ hasText: 'Print Hub' }).getByText('Matched', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('table[aria-label="Bank spending without a receipt"] tbody tr').length === 1);
  assert.match(await missing.innerText(), /POS OFFICE MART/);
  assert.deepEqual(consoleErrors, []);
});
