/**
 * Browser end-to-end test for payroll reports (RPT-010): two posted pay runs (one employee, then
 * two) and a draft; the report shows the months with the change in gross, the statutory amounts
 * and each employee, and downloads as CSV. Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const monthOf = (back) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fiscalYear = (m) => (Number(m.slice(5, 7)) >= 4 ? Number(m.slice(0, 4)) + 1 : Number(m.slice(0, 4)));
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1); // not money
    sum += Math.floor(p / 36) + (p % 36); // not money
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36];
};

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

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the payroll report shows months, statutory amounts and employees, and downloads as CSV', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Priya Payroll');
  await page.getByLabel('Email').fill(`e2e-payroll-report-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Payroll Report Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const [M2, M1, M0] = [monthOf(2), monthOf(1), monthOf(0)];
  for (const fy of new Set([M2, M1, M0].map(fiscalYear))) await call(`${B}/periods/fiscal-years`, { fiscalYear: fy });
  consoleErrors.length = 0; // the refused years log a 409 in the console; only the page's own errors count below
  await must(call(`${B}/payroll/settings`, {}, 'PUT'));
  const structure = (from, amount) => ({ effectiveFrom: `${from}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: amount }] });
  await must(call(`${B}/payroll/employees`, { code: 'E001', name: 'Asha Kulkarni', dateOfJoining: `${M2}-01`, structure: structure(M2, '30000') }));
  await must(call(`${B}/payroll/employees`, { code: 'E002', name: 'Ravi Shetty', dateOfJoining: `${M1}-01`, structure: structure(M1, '15000') }));
  for (const m of [M2, M1, M0]) {
    const run = await must(call(`${B}/payroll/runs`, { period: m, payDate: `${m}-28` }));
    if (m !== M0) await must(call(`${B}/payroll/runs/${run.id}/post`, {}));
  }

  await page.goto(`${base}/reports/payroll`);
  await page.getByLabel('From month').fill(M2);
  await page.getByLabel('To month').fill(M0);
  await Promise.all([page.waitForResponse((r) => r.url().includes(`/reports/payroll?from=${M2}`) && r.ok()), page.getByRole('button', { name: 'Show report' }).click()]);
  const months = page.getByRole('table', { name: 'Payroll by month' });
  await months.waitFor();
  const rows = months.locator('tbody tr');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.first().innerText(), /\b1\b[\s\S]*30,000\.00[\s\S]*—/);
  assert.match(await rows.nth(1).innerText(), /\b2\b[\s\S]*45,000\.00[\s\S]*50\.0%/);
  assert.match(await page.getByRole('table', { name: 'Statutory amounts' }).innerText(), /Provident fund[\s\S]*Employees\u2019 State Insurance[\s\S]*Professional tax[\s\S]*TDS on salary/);
  const people = await page.getByRole('table', { name: 'Payroll by employee' }).innerText();
  assert.match(people, /Asha Kulkarni[\s\S]*E001[\s\S]*\b2\b[\s\S]*60,000\.00[\s\S]*Ravi Shetty[\s\S]*E002[\s\S]*\b1\b[\s\S]*15,000\.00/);
  assert.equal(await page.getByText('Pay runs not posted').count(), 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/payroll-report.png`, fullPage: true });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download payroll report (CSV)' }).click()]);
  assert.equal(download.suggestedFilename(), `payroll-report-${M2}-to-${M0}.csv`);
  assert.deepEqual(consoleErrors, []);
});
