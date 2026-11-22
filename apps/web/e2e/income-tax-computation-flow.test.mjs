/**
 * Browser end-to-end test for the income tax computation (TAX-019, TAX-020): an owner with a year
 * of books (profit, depreciation, income tax expense, cash payments over 10,000 in a day, TDS and
 * advance tax) sees the computation for the last financial year, enters depreciation under section
 * 32, a brought forward loss and an add-back, saves it, and finalises it. Real Next.js app, API and
 * MongoDB.
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
// The last financial year runs from 1 April P to 31 March P+1.
const P = Number(T.slice(0, 4)) - (T.slice(5) < '04-01' ? 1 : 0) - 1;
const LAST = `${P}-${String(P + 1).slice(2)}`;

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

test('the income tax computation is prepared from the books, adjusted and finalised', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Computation');
  await page.getByLabel('Email').fill(`e2e-computation-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Computed Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  await call(`${B}/periods/fiscal-years`, { fiscalYear: P + 1 });
  const acc = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const journal = (date, debit, credit, amount) => must(call(`${B}/journals`, { date, post: true, memo: 'Computation flow', lines: [{ accountId: acc[debit], debit: amount }, { accountId: acc[credit], credit: amount }] }));
  await journal(`${P}-05-05`, '1120', '4100', '2000000.00');
  await journal(`${P}-06-01`, '6600', '1120', '600000.00');
  await journal(`${P + 1}-03-31`, '6800', '1520', '120000.00');
  await journal(`${P + 1}-03-31`, '8100', '2300', '250000.00');
  await journal(`${P}-09-15`, '1400', '1120', '100000.00');
  await journal(`${P}-10-10`, '1450', '1120', '20000.00');
  const kirana = (await must(call(`${B}/contacts`, { name: 'Local Kirana', isVendor: true }))).id;
  for (const amount of ['6000.00', '5000.00']) await must(call(`${B}/purchases/payments`, { contactId: kirana, date: `${P}-06-03`, bankAccountId: acc['1110'], amount, allocations: [] }));
  await must(call(`${B}/tax/advance-tax`, { taxYear: LAST, regime: 'COMPANY_22', method: 'ANNUALISE', estimatedIncome: null, adjustments: [], paidAccountId: acc['1400'], tdsAccountId: acc['1450'], otherCredits: '0' }, 'PUT'));
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/income-computation`);
  const lines = page.getByRole('table', { name: 'Computation of total income' });
  await lines.waitFor();
  assert.equal(await page.getByLabel('Financial year').inputValue(), LAST);
  const before_ = await lines.innerText();
  assert.match(before_, /12,80,000\.00[\s\S]*1,20,000\.00[\s\S]*40A\(3\)[\s\S]*11,000\.00/);
  await page.getByText('Enter the depreciation allowed under section 32').waitFor();

  await page.getByLabel('Depreciation under section 32').fill('150000');
  await page.getByLabel('Business loss brought forward').fill('200000');
  await page.getByRole('button', { name: 'Add an adjustment' }).click();
  await page.getByLabel('Adjustment 1 description').fill('Donations not deductible');
  await page.getByLabel('Adjustment 1 section').fill('37(1)');
  await page.getByLabel('Adjustment 1 amount').fill('10000');
  await page.getByRole('button', { name: 'Save computation' }).click();
  await page.getByText('Last saved by Tara Computation').waitFor();
  const after_ = await lines.innerText();
  assert.match(after_, /Depreciation[\s\S]*1,50,000\.00[\s\S]*Donations not deductible[\s\S]*37\(1\)[\s\S]*10,000\.00/);
  assert.match(after_, /12,71,000\.00[\s\S]*2,00,000\.00[\s\S]*10,71,000\.00/);
  const tax = await page.getByRole('table', { name: 'Tax on total income' }).innerText();
  assert.match(tax, /2,35,620\.00[\s\S]*23,562\.00[\s\S]*10,367\.28[\s\S]*2,69,550\.00[\s\S]*Self-assessment tax to pay\s*₹1,49,550\.00/);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/income-tax-computation.png`, fullPage: true });

  await page.getByRole('button', { name: 'Finalise computation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finalise', exact: true }).click();
  await page.getByText('Final', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save computation' }).count(), 0);
  assert.equal(await page.getByLabel('Depreciation under section 32').isDisabled(), true);
  const saved = await must(call(`${B}/tax/income-computation?year=${LAST}`));
  assert.equal(saved.status, 'FINAL');
  assert.equal(saved.payable, '149550.00');
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/income-tax-computation-final.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
