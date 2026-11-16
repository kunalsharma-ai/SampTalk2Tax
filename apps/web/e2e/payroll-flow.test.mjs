/**
 * Browser end-to-end test for India payroll: an owner sets up payroll with the default
 * accounts, adds an employee with a PAN, a salary structure and salary from a previous
 * employer this tax year, creates this month's pay run, adjusts loss-of-pay days, posts it
 * to the ledger, opens the payslip, pays net salaries from the bank, and cannot void the
 * run while a payment stands. Expected figures come from the same tax engine the API uses,
 * and for October 2026 they are also checked against hand-worked numbers.
 * Real Next.js app → real API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { computePayslip, daysInMonth, monthsLeftInTaxYear, taxYearLabel } from '@talk2tax/tax-engine';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const today = () => new Date().toISOString().slice(0, 10);
const PERIOD = today().slice(0, 7);
const NAME = 'Meera Iyer (synthetic)';
let browser, page, orgId, base, runId, employeeId;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);
const inr = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(Number(v));

const expected = (paidDays) =>
  computePayslip({
    period: PERIOD,
    paidDays: String(paidDays),
    components: [
      { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '60000' },
      { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthly: '30000' },
      { code: 'SPECIAL', name: 'Special allowance', kind: 'WAGES', monthly: '20000' },
    ],
    pf: { member: true, eps: true, onFullWages: false },
    esiCoveredForPeriod: null,
    pt: { stateCode: '27', category: 'GENERAL' },
    tax: { incomeBefore: '900000', tdsBefore: '30000', futureMonths: monthsLeftInTaxYear(PERIOD) - 1, hasPan: true },
  });

async function call(p, path, body, method = body ? 'POST' : 'GET') {
  return p.evaluate(
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

test('the hand-worked October 2026 payslip matches the engine', () => {
  // Gross 1,10,000; PF on the Rs 25,000 ceiling 3,000; PT 200; annual tax 46,800 less 23,400 over 6 months = 3,900.
  const r = computePayslip({
    period: '2026-10',
    paidDays: '31',
    components: [
      { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '60000' },
      { code: 'HRA', name: 'HRA', kind: 'EXCLUDED', monthly: '30000' },
      { code: 'SPECIAL', name: 'Special', kind: 'WAGES', monthly: '20000' },
    ],
    pf: { member: true, eps: true, onFullWages: false },
    esiCoveredForPeriod: null,
    pt: { stateCode: '27', category: 'GENERAL' },
    tax: { incomeBefore: '660000', tdsBefore: '23400', futureMonths: 5, hasPan: true },
  });
  assert.deepEqual([r.gross, r.pf.employee, r.pt.amount, r.tds.amount, r.net], ['110000.00', '3000.00', '200.00', '3900.00', '102900.00']);
});

test('an owner sets up payroll and adds an employee', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Payroll Owner');
  await page.getByLabel('Email').fill(`e2e-payroll-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Payroll Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `${WEB}/orgs/${orgId}`;

  await page.goto(`${base}/payroll/runs`);
  await page.getByText('Payroll is not set up').waitFor();
  await page.goto(`${base}/settings/payroll`);
  await page.getByRole('button', { name: 'Set up payroll' }).click();
  await page.getByLabel('PF establishment code').fill('MHBAN0012345000');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('6100 · Salaries and Wages').waitFor();
  await page.getByText('Statutory rules in use').waitFor();

  await page.goto(`${base}/payroll/employees`);
  await page.getByRole('button', { name: 'New employee' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Employee code').fill('E001');
  await d.getByLabel('Name', { exact: true }).fill(NAME);
  await d.getByLabel('PAN').fill('zzzpi1201z');
  await d.getByLabel('Date of joining').fill(`${taxYearLabel(PERIOD).slice(0, 4)}-04-01`);
  await d.getByLabel('Work state').selectOption('27');
  await d.getByText('Salary from a previous employer this tax year').click();
  await d.getByLabel('Tax year').fill(taxYearLabel(PERIOD));
  await d.getByLabel('Taxable salary (₹)').fill('900000');
  await d.getByLabel('TDS deducted (₹)').fill('30000');
  await d.getByLabel('Monthly amount for component 1').fill('60000');
  await d.getByLabel('Monthly amount for component 2').fill('30000');
  await d.getByLabel('Monthly amount for component 3').fill('20000');
  await d.getByRole('button', { name: 'Add employee' }).click();
  // Adding opens the employee's page, with the salary history.
  await page.waitForURL(/\/payroll\/employees\/[0-9a-f-]{36}$/);
  employeeId = page.url().split('/').pop();
  await page.getByText(inr('110000')).first().waitFor();
  await page.goto(`${base}/payroll/employees`);
  await page.getByRole('row', { name: /E001/ }).getByText(inr('110000')).waitFor();
});

test('a pay run is drafted, adjusted for loss of pay and posted to the ledger', async () => {
  // The joining date is the start of the tax year, so months before this one have no pay run;
  // the previous-employer figures stand in for them.
  await page.goto(`${base}/payroll/runs`);
  await page.getByRole('button', { name: 'New pay run' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/payroll\/runs\/[0-9a-f-]{36}$/);
  runId = page.url().split('/').pop();
  await page.getByText('Nothing is in the ledger yet').waitFor();
  const full = expected(daysInMonth(PERIOD));
  const row = page.getByRole('row', { name: new RegExp(NAME.replace(/[()]/g, '\\$&')) });
  await row.getByText(inr(full.net), { exact: true }).waitFor();

  await page.getByRole('button', { name: `Adjust ${NAME}` }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Loss-of-pay days').fill('3');
  await d.getByRole('button', { name: 'Recalculate payslip' }).click();
  await d.waitFor({ state: 'hidden' });
  const lop = expected(daysInMonth(PERIOD) - 3);
  await row.getByText(inr(lop.net), { exact: true }).waitFor();
  assert.ok(await row.getByText(inr(lop.tds.amount), { exact: true }).isVisible());
  await shot(page, 'payroll-draft-adjusted');

  await page.getByRole('button', { name: 'Post pay run' }).click();
  await page.getByText('Posted', { exact: true }).first().waitFor();
  const run = (await call(page, `/v1/orgs/${orgId}/payroll/runs/${runId}`)).body;
  assert.equal(run.status, 'POSTED');
  assert.equal(run.totals.net, lop.net);
  const journal = (await call(page, `/v1/orgs/${orgId}/journals/${run.journalEntryId}`)).body;
  assert.equal(journal.source, 'PAYROLL');
  const sum = (k) => journal.lines.reduce((s, l) => s + Math.round(Number(l[k]) * 100), 0);
  assert.equal(sum('debit'), sum('credit'));
  assert.equal(sum('debit'), Math.round((Number(lop.gross) + Number(lop.pf.eps) + Number(lop.pf.epfEmployer) + Number(lop.pf.edli) + Number(lop.pf.admin) + Number(lop.esi.employer)) * 100));
});

test('the payslip shows the deductions and the tax working', async () => {
  await page.getByRole('link', { name: NAME }).click();
  await page.waitForURL(/\/payslips\//);
  const lop = expected(daysInMonth(PERIOD) - 3);
  await page.getByLabel('Net pay').waitFor();
  assert.equal((await page.getByLabel('Net pay').textContent()).trim(), inr(lop.net));
  await page.getByRole('heading', { name: 'Income-tax working' }).waitFor();
  assert.ok(await page.getByText('ZZZPI1201Z').isVisible());
  assert.notEqual(lop.tds.annualTax, '0.00');
  await page.getByRole('row', { name: /Tax for the year/ }).getByText(inr(lop.tds.annualTax), { exact: true }).waitFor();
  await shot(page, 'payroll-payslip');
});

test('net salaries are paid from the bank, and a paid run cannot be voided', async () => {
  await page.goto(`${base}/payroll/runs/${runId}`);
  await page.getByRole('button', { name: 'Pay Net salaries' }).click();
  const d = page.getByRole('dialog');
  const bank = await d.getByLabel('Paid from').locator('option').nth(1).getAttribute('value');
  await d.getByLabel('Paid from').selectOption(bank);
  await d.getByLabel('Reference').fill('NEFT-E2E-001');
  await d.getByRole('button', { name: 'Record payment' }).click();
  await d.waitFor({ state: 'hidden' });
  await page.getByText(/PAYP-000001/).waitFor();
  const run = (await call(page, `/v1/orgs/${orgId}/payroll/runs/${runId}`)).body;
  assert.equal(run.liabilities.find((l) => l.liability === 'NET_PAY').payment.reference, 'NEFT-E2E-001');

  await page.getByRole('button', { name: 'Void pay run' }).click();
  const v = page.getByRole('dialog');
  await v.getByLabel('Reason').fill('Wrong month');
  await v.getByRole('button', { name: 'Void pay run' }).click();
  await v.getByText(/Void the payments recorded against/).waitFor();
  // The 409 for the refused void is expected; nothing else may log an error.
  const unexpected = consoleErrors.filter((e) => !/409/.test(e));
  assert.deepEqual(unexpected, []);
});
