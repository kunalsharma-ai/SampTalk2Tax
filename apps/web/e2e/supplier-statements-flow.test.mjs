/**
 * Browser end-to-end test for supplier statement reconciliation (AP-011): an owner pastes a
 * supplier's statement, sees each line matched to a bill or payment, the bill they have not
 * entered, the payment the supplier has not recorded and a price difference, corrects a balance
 * typed wrongly, and marks the statement reconciled with a note. Real Next.js app, API and MongoDB.
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
const day = (n) => new Date(Date.parse(`${T}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const fy = (iso) => (Number(iso.slice(5, 7)) >= 4 ? Number(iso.slice(0, 4)) + 1 : Number(iso.slice(0, 4))); // not money

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

test('a supplier statement is matched to the books, corrected and reconciled', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Sana Statements');
  await page.getByLabel('Email').fill(`e2e-supplier-statements-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Reconciling Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  for (const d of new Set([fy(day(-60)), fy(T)])) await call(`${B}/periods/fiscal-years`, { fiscalYear: d });
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = (await must(call(`${B}/contacts`, { name: 'Paper Mart (synthetic)', isVendor: true }))).id;
  const bill = (date, amount, reference) => must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: date, dueDate: date, reference, post: true, lines: [{ accountId: acc['6600'], description: 'Stationery', quantity: '1', unitPrice: amount }] }));
  await bill(day(-60), '1000.00', 'PM/090');
  await bill(day(-30), '11800.00', 'PM/101');
  await bill(day(-13), '2360.00', 'PM/115');
  await must(call(`${B}/purchases/payments`, { contactId: vendor, date: day(-18), bankAccountId: acc['1120'], amount: '11800.00', reference: 'UTR1111' }));
  await must(call(`${B}/purchases/payments`, { contactId: vendor, date: day(-3), bankAccountId: acc['1120'], amount: '3000.00' }));
  consoleErrors.length = 0;

  await page.goto(`${base}/purchases/supplier-statements`);
  await page.getByText('No statements yet').waitFor();
  await page.getByRole('link', { name: 'Reconcile a statement' }).click();
  await page.getByLabel('Supplier').selectOption({ label: 'Paper Mart (synthetic)' });
  await page.getByLabel('Statement from').fill(day(-35));
  await page.getByLabel('Statement to').fill(day(-1));
  await page.getByLabel('Their opening balance').fill('1000.00');
  await page.getByLabel('Their closing balance').fill('4600.00'); // typed wrongly: should be 4,580
  await page.getByLabel('Statement lines').fill(['Date,Reference,Type,Amount', `${dmy(day(-30))},PM-0101,Invoice,"11,800.00"`, `${dmy(day(-13))},PM/115,Invoice,2400.00`, `${dmy(day(-15))},NEFT 1111,Payment,11800.00`, `${dmy(day(-5))},PM/121,Invoice,1180.00`].join('\n'));
  await page.getByText('4 lines read.').waitFor();
  await page.getByRole('button', { name: 'Reconcile' }).click();
  await page.waitForURL(/\/purchases\/supplier-statements\/[0-9a-f-]{36}$/);

  await page.getByText('The statement does not add up').waitFor();
  await page.getByRole('button', { name: 'Correct the statement as entered' }).click();
  const fix = page.getByRole('region', { name: 'Correct the statement' });
  await fix.getByLabel('Their closing balance').fill('4580.00');
  await fix.getByRole('button', { name: 'Save and reconcile again' }).click();
  await page.getByText('They show INR 4220.00 more than your books').waitFor();
  // Theirs 4,580; ours 1,000 + 11,800 + 2,360 - 11,800 - 3,000 = 360.
  const parts = await page.getByRole('region', { name: 'Where the difference comes from' }).innerText();
  assert.match(parts, /Lines only on their statement\s+₹1,180\.00[\s\S]*Items only in your books\s+₹3,000\.00[\s\S]*Matched amounts that differ\s+₹40\.00[\s\S]*Their statement does not add up\s+₹0\.00/);
  assert.match(await page.getByRole('region', { name: 'Only on their statement' }).innerText(), /PM\/121\s+Invoice\s+₹1,180\.00\s+Not in your books/);
  assert.match(await page.getByRole('region', { name: 'Only in your books' }).innerText(), /PAY-\d+\s+Payment[\s\S]*-₹3,000\.00\s+Not on their statement yet/);
  const matched = await page.getByRole('region', { name: 'Lines matched' }).innerText();
  assert.match(matched, /PM-0101[\s\S]*BILL-\d+\s+Reference[\s\S]*PM\/115[\s\S]*INR 40\.00[\s\S]*NEFT 1111[\s\S]*Amount and date/);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/supplier-statement.png`, fullPage: true });

  const close = page.getByRole('region', { name: 'Mark reconciled' });
  assert.equal(await close.getByRole('button', { name: 'Mark reconciled' }).isDisabled(), true);
  await close.getByLabel('Note').fill('Asked for invoice PM/121 and a credit of 40.00; the 3,000 payment is on its way.');
  await close.getByRole('button', { name: 'Mark reconciled' }).click();
  await page.getByText(/^Reconciled by Sana Statements on /).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Mark reconciled' }).count(), 0);

  await page.getByRole('link', { name: 'All statements' }).click();
  const list = page.getByRole('region', { name: 'Statements received' });
  await list.getByText('Reconciled', { exact: true }).waitFor();
  assert.match(await list.innerText(), /Paper Mart \(synthetic\)\s+4 lines[\s\S]*₹4,580\.00\s+₹360\.00\s+₹4,220\.00\s+Reconciled/);
  assert.deepEqual(consoleErrors, []);
});
