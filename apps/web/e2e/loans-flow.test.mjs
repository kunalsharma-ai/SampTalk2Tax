/**
 * Browser end-to-end test for loans and treasury: an owner adds a term loan with its schedule
 * previewed as they type, records installments (one with the lender's own split), changes the
 * rate and reverses it, prepays with charges, and reads the treasury overview with its ledger
 * check. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));
const M = T.slice(0, 7);
const DISB = `${shift(M, -5)}-10`;
const FIRST = `${shift(M, -4)}-01`;

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
after(async () => {
  await browser?.close();
});

test('an owner adds a loan, records installments, changes the rate, prepays and reads the treasury', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Loan Owner');
  await page.getByLabel('Email').fill(`e2e-loans-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Loans Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const fy of new Set([fyOf(shift(M, -5)), fyOf(M)])) if (!years.has(fy)) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fy })).status, 201);

  await page.getByRole('link', { name: 'Loans', exact: true }).click();
  await page.getByRole('heading', { name: 'Loans', exact: true }).waitFor();
  await page.getByText('No loans yet').waitFor();
  await page.getByRole('link', { name: 'Add a loan' }).click();
  await page.getByRole('heading', { name: 'Add a loan' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Warehouse term loan');
  await page.getByLabel('Lender').fill('State Bank of India');
  await page.getByLabel('Amount borrowed').fill('1000000');
  await page.getByLabel('Interest rate (% a year)').fill('9.5');
  await page.getByLabel('Term (months)').fill('60');
  await page.getByLabel('Received on').fill(DISB);
  await page.getByLabel('First installment due').fill(FIRST);
  await page.getByText('₹21,001.86').first().waitFor();
  assert.equal(await page.getByRole('table', { name: 'Schedule preview' }).locator('tbody tr').count(), 60);
  await page.getByRole('button', { name: 'Add loan' }).click();
  await page.getByRole('heading', { name: 'LN-0001 Warehouse term loan' }).waitFor();
  await page.getByText(/installments are due and not recorded/).waitFor();

  const actions = page.getByLabel('Loan actions');
  await actions.getByText(/Installment 1, due/).waitFor();
  await actions.getByRole('button', { name: 'Record installment 1' }).click();
  await actions.getByRole('button', { name: 'Record installment 2' }).waitFor();
  await page.getByText('₹9,86,914.81').first().waitFor();
  await actions.getByText('The lender charged a different split').click();
  await actions.getByLabel('Principal').fill('13101.86');
  await actions.getByLabel('Interest', { exact: true }).fill('7900.00');
  await actions.getByRole('button', { name: 'Record installment 2' }).click();
  await actions.getByRole('button', { name: 'Record installment 3' }).waitFor();
  await page.getByText('₹9,73,812.95').first().waitFor();

  await actions.getByRole('tab', { name: 'Change rate' }).click();
  await actions.getByLabel('New rate (% a year)').fill('10.25');
  await actions.getByRole('button', { name: 'Change rate' }).click();
  await page.getByText('Started at 9.5%').waitFor();
  const entries = page.getByRole('table', { name: 'Loan entries' });
  await entries.getByText('Rate 9.5% to 10.25% (term changes)').waitFor();
  await entries.getByRole('button', { name: 'Reverse…' }).click();
  await entries.getByRole('button', { name: /Reverse rate 9.5% to 10.25%/ }).click();
  await entries.getByText('Reversed by Loan Owner').waitFor();
  assert.equal(await page.getByText('Started at 9.5%').count(), 0);

  await actions.getByRole('tab', { name: 'Prepay' }).click();
  await actions.getByLabel('Principal prepaid').fill('200000');
  await actions.getByLabel('Prepayment charges (optional)').fill('4000');
  await actions.getByRole('button', { name: 'Record prepayment' }).click();
  await entries.getByText('Prepayment (finish sooner)').waitFor();
  await page.getByText('₹7,73,812.95').first().waitFor();
  await entries.getByRole('row', { name: /Prepayment/ }).getByRole('link').first().click();
  await page.getByText('Created by a loan (LN-0001)').waitFor();

  await page.getByRole('link', { name: 'Treasury', exact: true }).click();
  await page.getByRole('heading', { name: 'Treasury', exact: true }).waitFor();
  await page.getByText('Net debt').waitFor();
  await page.getByRole('table', { name: 'Installments due' }).getByText('LN-0001 Warehouse term loan').first().waitFor();
  await page.getByRole('table', { name: 'Ledger check' }).getByText('Agrees').waitFor();
  assert.equal(await page.getByRole('table', { name: 'Repayments by month' }).locator('tbody tr').count() >= 12, true);

  await page.getByRole('link', { name: 'Loans', exact: true }).first().click();
  const row = page.getByRole('table', { name: 'Loans' }).getByRole('row', { name: /LN-0001/ });
  await row.getByText('₹7,73,812.95').waitFor();
  await row.getByText(/overdue/).waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
