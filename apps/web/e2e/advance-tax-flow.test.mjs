/**
 * Browser end-to-end test for advance tax (TAX-021): the owner books profit, an advance tax
 * payment and TDS, opens Advance tax from the menu, saves a plan with an estimate and an
 * adjustment, and sees the tax with surcharge and cess and the four instalments.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const START = Number(T.slice(5, 7)) >= 4 ? Number(T.slice(0, 4)) : Number(T.slice(0, 4)) - 1;
const FROM = `${START}-04-01`;
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);

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
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the year\'s advance tax is planned and checked against payments', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tax Owner');
  await page.getByLabel('Email').fill(`e2e-advtax-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Advance Tax Pvt Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  for (const [code, name] of [['1460', 'Advance Tax Paid'], ['1470', 'TDS Receivable']]) {
    const r = await call(`${base}/accounts`, { code, name, type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' });
    assert.equal(r.status, 201);
    acc[code] = r.body.id;
  }
  for (const [dr, cr, amount] of [['1120', '4100', '3000000.00'], ['6200', '1120', '600000.00'], ['1470', '4100', '20000.00'], ['1460', '1120', '75000.00']]) {
    const r = await call(`${base}/journals`, { date: FROM, memo: 'Advance tax e2e', post: true, lines: [{ accountId: acc[dr], debit: amount }, { accountId: acc[cr], credit: amount }] });
    assert.equal(r.status, 201);
  }

  await page.getByRole('link', { name: 'Advance tax', exact: true }).click();
  await page.getByRole('heading', { name: 'Advance tax', exact: true }).waitFor();
  await page.getByText('Not saved for this year yet').waitFor();
  const books = page.getByRole('table', { name: 'Tax for the year' });
  await books.getByText('2,420,000.00').or(books.getByText('24,20,000.00')).first().waitFor();

  await page.getByRole('button', { name: 'Edit plan' }).click();
  await page.getByLabel('Taxed as').selectOption('COMPANY_22');
  await page.getByLabel('Income for the year').selectOption('ESTIMATE');
  await page.getByLabel('Estimated profit before tax for the year').fill('5000000');
  await page.getByRole('button', { name: 'Add an adjustment' }).click();
  await page.getByLabel('Adjustment 1', { exact: true }).fill('Penalties not allowed');
  await page.getByLabel('Amount for adjustment 1').fill('100000');
  await page.getByLabel('Advance tax paid account').selectOption({ label: '1460 Advance Tax Paid' });
  await page.getByLabel('Tax deducted at source account').selectOption({ label: '1470 TDS Receivable' });
  await page.getByRole('button', { name: 'Save plan' }).click();
  await page.getByText(/Saved .* by Tax Owner/).waitFor();
  await shot('01-advance-tax');

  // 51,00,000 at 22% = 11,22,000; surcharge 1,12,200; cess 49,368; total 12,83,568 → 12,83,570; less TDS 20,000.
  const r = (await call(`${base}/tax/advance-tax`)).body;
  assert.equal(r.tax.total, '1283570.00');
  assert.equal(r.netLiability, '1263570.00');
  assert.equal(r.paid, '75000.00');
  const rows = page.getByRole('table', { name: 'Advance tax instalments' }).locator('tbody tr');
  assert.equal(await rows.count(), 4);
  assert.match(await rows.nth(0).textContent(), /15%/);
  assert.match(await rows.nth(3).textContent(), /12,63,570|1,263,570/);
  await page.getByRole('table', { name: 'Advance tax instalments' }).scrollIntoViewIfNeeded();
  await shot('02-instalments');
  assert.deepEqual(consoleErrors, []);
});
