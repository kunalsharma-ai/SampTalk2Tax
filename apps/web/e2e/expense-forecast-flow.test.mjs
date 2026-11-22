/**
 * Browser end-to-end test for expense forecasting (EXP-025): an employee's travel claims over six
 * months, approved and paid back, plus one approved this month and one waiting; the forecast page
 * shows the expected spending with its range, the money owed to employees and an account used only
 * once. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const monthDay = (back) => {
  if (back === 0) return T;
  const d = new Date(Date.parse(`${T.slice(0, 7)}-01T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() - back);
  return `${d.toISOString().slice(0, 8)}10`;
};
let browser, owner, employee;
const consoleErrors = [];

async function call(page, path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };
async function register(page, name, email) {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
}

before(async () => {
  browser = await chromium.launch();
  owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  employee = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, employee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the expense forecast shows expected spending and what is owed', async () => {
  await register(owner, 'Tara Forecast', `e2e-expfc-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Expense Forecast Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const email = `e2e-expfc-emp-${randomUUID()}@example.test`;
  await register(employee, 'Dev Traveller', email);
  await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));
  const claim = async (back, code, amount, then) => {
    const c = await must(call(employee, `${B}/expense-claims`, { title: `Trip ${back}`, lines: [{ date: monthDay(back), accountId: acc[code], merchant: 'Synthetic Travels', amount }] }));
    await must(call(employee, `${B}/expense-claims/${c.id}/submit`, {}));
    if (then === 'submit') return;
    await must(call(owner, `${B}/expense-claims/${c.id}/approve`, {}));
    if (then === 'reimburse') await must(call(owner, `${B}/expense-claims/${c.id}/reimburse`, { bankAccountId: acc['1120'], date: T }));
  };
  for (const [back, amount] of [[6, '3000.00'], [5, '3000.00'], [4, '3000.00'], [3, '4000.00'], [2, '5000.00'], [1, '6000.00']]) await claim(back, '6700', amount, 'reimburse');
  await claim(5, '6600', '2500.00', 'reimburse');
  await claim(0, '6700', '1200.00', 'approve');
  await claim(0, '6700', '700.00', 'submit');

  await owner.goto(`${base}/expenses/forecast`);
  await owner.getByRole('heading', { name: 'Expense forecast' }).waitFor();
  const table = owner.getByRole('table', { name: 'Forecast by account' });
  const travel = table.getByRole('row').filter({ hasText: '6700' });
  await travel.getByText('Recent average').waitFor();
  const text = await travel.innerText();
  assert.match(text, /\+66\.7% on the 3 months before/);
  assert.match(text, /5,000\.00[\s\S]*3,845\.30 to [\s\S]*6,154\.70/);
  assert.match(text, /So far [\s\S]*1,200\.00/);
  await owner.getByText('1 approved claim not yet paid back').waitFor();
  await owner.getByText('1 submitted claim').waitFor();
  const occasional = owner.getByRole('table', { name: 'Spent on now and then' });
  assert.match(await occasional.innerText(), /6600[\s\S]*2,500\.00/);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/expense-forecast.png`, fullPage: true });

  // Six months ahead: six forecast columns.
  await owner.getByLabel('Months ahead').selectOption('6');
  await table.getByRole('columnheader').nth(7).waitFor();
  assert.equal(await table.getByRole('columnheader').count(), 8);

  assert.deepEqual(consoleErrors, []);
});
