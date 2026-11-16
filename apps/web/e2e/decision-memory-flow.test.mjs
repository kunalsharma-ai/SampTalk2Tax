/**
 * Browser end-to-end test for decision memory: an owner records a pricing decision with an
 * assumption and an expected outcome, sees the outcome measured from the books, reviews it with
 * lessons learned, finds it again by searching for a word from the lessons, records a recovery
 * plan as a decision and withdraws that one with a reason.
 * Real Next.js app → real API → real PostgreSQL.
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
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));
const M0 = shift(T.slice(0, 7), -2);
const M1 = shift(T.slice(0, 7), -1);
let withdrawReason = '';
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(withdrawReason) : d.accept()));
});
after(async () => {
  await browser?.close();
});

test('an owner records a decision, sees it measured, reviews it, finds it by its lesson, and records and withdraws a plan', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Decide');
  await page.getByLabel('Email').fill(`e2e-decide-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Decision Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const m of [M0, M1]) if (!years.has(fyOf(m))) (await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(m) }), years.add(fyOf(m)));
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const j = async (date, dr, cr, amount) => assert.equal((await call(`${base}/journals`, { date, memo: 'Decision e2e', post: true, lines: [{ accountId: acc[dr], debit: amount }, { accountId: acc[cr], credit: amount }] })).status, 201);
  await j(`${M0}-10`, '1120', '4100', '100000.00');
  await j(`${M0}-12`, '5000', '1120', '70000.00'); // 30% gross margin before
  await j(`${M1}-20`, '1120', '4100', '120000.00');
  await j(`${M1}-22`, '5000', '1120', '72000.00'); // 40% after

  // Record a decision.
  await page.getByRole('link', { name: 'Decision memory' }).click();
  await page.getByText('No decisions recorded yet').waitFor();
  await page.getByRole('link', { name: 'Record a decision' }).click();
  await page.getByLabel('Title').fill('Raise trade prices by 8%');
  await page.getByLabel('What was decided').fill('Raise list prices on trade goods by 8% from the start of the month.');
  await page.getByLabel('Category').selectOption('PRICING');
  await page.getByLabel('Decided on').fill(`${M1}-03`);
  await page.getByLabel('Decided by').fill('Board meeting');
  await page.getByLabel('Assumption 1', { exact: true }).fill('Customers accept the rise without leaving.');
  await page.getByRole('button', { name: 'Add an expected outcome' }).click();
  await page.getByLabel('Measure 1').selectOption('grossMargin');
  await page.getByLabel('Target 1').fill('35');
  await page.getByLabel('Month 1').fill(M1);
  await page.getByRole('button', { name: 'Record decision' }).click();
  await page.waitForURL(/\/decisions\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'DM-0001 · Raise trade prices by 8%' }).waitFor();
  const outcomes = page.getByRole('table', { name: 'Expected outcomes' });
  await outcomes.getByText(/^Met: gross margin was 40\.0% in .*, against 30\.0% before the decision\. Expected at least 35\.0%\.$/).waitFor();
  await outcomes.getByText('Met', { exact: true }).waitFor();

  // Review it: the verdict the books suggest is already chosen.
  await page.getByRole('button', { name: 'Review outcome' }).click();
  assert.equal(await page.getByLabel('Verdict').inputValue(), 'WORKED');
  await page.getByLabel('Did assumption 1 hold?').selectOption('yes');
  await page.getByLabel('What happened').fill('Margin recovered within the month.');
  await page.getByLabel('Lessons learned').fill('Small, announced price rises stick with wholesale buyers.');
  await page.getByRole('button', { name: 'Save review' }).click();
  await page.getByLabel('Lessons learned').filter({ hasText: 'Small, announced price rises' }).waitFor();
  await page.getByText('Worked', { exact: true }).first().waitFor();
  await page.getByRole('list', { name: 'Assumptions' }).getByText('Held', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review outcome' }).count(), 0);

  // Find it again by a word from its lessons.
  await page.getByRole('link', { name: 'Decision memory' }).first().click();
  await page.getByLabel('Search').fill('wholesale');
  await page.getByRole('table', { name: 'Decisions' }).getByRole('link', { name: 'Raise trade prices by 8%' }).waitFor();
  await page.getByLabel('Search').fill('nothing like this');
  await page.getByText('No decisions match').waitFor();

  // Record a recovery plan as a decision, then withdraw it.
  const plan = await call(`${base}/recovery/plans`, { name: 'Protect cash this quarter', description: 'Hold spending until collections improve.', baselineMonths: 3, horizonMonths: 12 });
  assert.equal(plan.status, 201);
  assert.equal((await call(`${base}/recovery/plans/${plan.body.id}`, { status: 'ACTIVE' }, 'PUT')).status, 200);
  await page.goto(`${WEB}/orgs/${orgId}/planning/recovery/${plan.body.id}`);
  await page.getByRole('link', { name: 'Record as a decision' }).click();
  await page.waitForURL(/\/decisions\/new\?sourceType=RECOVERY_PLAN/);
  assert.equal(await page.getByLabel('Title').inputValue(), 'Protect cash this quarter');
  assert.match(await page.getByLabel('What was decided').inputValue(), /^Carry out the recovery plan "Protect cash this quarter":/);
  await page.getByRole('button', { name: 'Record decision' }).click();
  await page.waitForURL(/\/decisions\/[0-9a-f-]{36}$/);
  await page.getByRole('link', { name: 'Recovery plan Protect cash this quarter' }).waitFor();
  withdrawReason = 'Collections recovered before the plan started.';
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByText(withdrawReason).waitFor();
  await page.getByText('Withdrawn', { exact: true }).first().waitFor();

  assert.deepEqual(consoleErrors, []);
});
