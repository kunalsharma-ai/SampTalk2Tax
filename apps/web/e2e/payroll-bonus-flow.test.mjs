/**
 * Browser end-to-end test for the statutory bonus (PAY-007): payslips posted for two months,
 * the bonus page works out each employee's bonus, and adding it puts a one-off earning on a
 * draft pay run. Real Next.js app → real API → real MongoDB.
 * Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
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

test('the bonus for the year is worked out and added to a draft pay run', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Bonus Owner');
  await page.getByLabel('Email').fill(`e2e-bonus-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Bonus Works');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;

  const t = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
  const YEAR = `${FY}-${String((FY + 1) % 100).padStart(2, '0')}`;
  assert.equal((await call(`${base}/payroll/settings`, {}, 'PUT')).status, 200);
  const salary = (basic, hra) => ({ effectiveFrom: `${FY}-04-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: basic }, { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthlyAmount: hra }] });
  assert.equal((await call(`${base}/payroll/employees`, { code: 'W001', name: 'Kavita Shinde', dateOfJoining: `${FY}-04-01`, structure: salary('14000', '6000') })).status, 201);
  assert.equal((await call(`${base}/payroll/employees`, { code: 'W002', name: 'Rahul Desai', dateOfJoining: `${FY}-04-01`, structure: salary('40000', '20000') })).status, 201);
  for (const m of ['04', '05']) {
    const r = await call(`${base}/payroll/runs`, { period: `${FY}-${m}`, payDate: `${FY}-${m}-28` });
    assert.equal(r.status, 201);
    assert.equal((await call(`${base}/payroll/runs/${r.body.id}/post`, {})).status, 200);
  }
  const june = (await call(`${base}/payroll/runs`, { period: `${FY}-06`, payDate: `${FY}-06-28` })).body;

  await page.goto(`${WEB}/orgs/${orgId}/payroll/bonus`);
  await page.getByRole('heading', { name: 'Statutory bonus', exact: true }).waitFor();
  await page.getByLabel('Accounting year').selectOption(YEAR);
  const table = page.getByRole('table', { name: 'Bonus by employee' });
  // Two months at the 7,000 ceiling, at 8.33%.
  await table.getByRole('row', { name: /Kavita Shinde/ }).getByText('₹1,166.20').first().waitFor();
  await table.getByRole('row', { name: /Rahul Desai/ }).getByText('Wages were above 21000 a month all year').waitFor();
  // At 20%, the bonus changes with the rate.
  await page.getByLabel('Bonus rate (%)').fill('20');
  await table.getByRole('row', { name: /Kavita Shinde/ }).getByText('₹2,800.00').first().waitFor();
  await page.getByLabel('Bonus rate (%)').fill('8.33');
  await table.getByRole('row', { name: /Kavita Shinde/ }).getByText('₹1,166.20').first().waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-bonus-worked-out.png`, fullPage: true });

  await page.getByLabel('Draft pay run').selectOption(june.id);
  await page.getByRole('button', { name: 'Add bonus to the run' }).click();
  await page.getByText(`Added to ${june.number} for 1 employee`).waitFor();
  await page.getByText('Rahul Desai: Wages were above 21000 a month all year').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-bonus-added.png`, fullPage: true });

  const run = (await call(`${base}/payroll/runs/${june.id}`)).body;
  const slip = run.payslips.find((s) => s.employee.code === 'W001');
  assert.deepEqual(slip.oneOffs, [{ name: `Statutory bonus ${YEAR}`, kind: 'EXCLUDED', amount: '1166.20' }]);
  assert.equal(slip.wages, '14000.00');
  assert.deepEqual(consoleErrors, []);
});
