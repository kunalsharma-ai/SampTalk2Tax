/**
 * Browser end-to-end test for the forecast evaluation lab: an owner with twelve months of rising
 * sales opens the lab, sees the methods ranked on their own books with the straight-line trend
 * best, switches the figure and the months checked, saves a run with a note and opens the saved
 * run with its forecasts waiting to be measured.
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
const LAST = shift(T.slice(0, 7), -1);
const MONTHS = Array.from({ length: 12 }, (_, i) => shift(LAST, i - 11));
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
});
after(async () => {
  await browser?.close();
});

test('an owner compares forecasting methods on their own books and saves a run to measure later', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Fay Forecast');
  await page.getByLabel('Email').fill(`e2e-lab-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Forecast Lab Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const m of MONTHS) if (!years.has(fyOf(m))) (await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(m) }), years.add(fyOf(m)));
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  for (const [i, m] of MONTHS.entries()) {
    const amount = `${100000 + i * 10000}.00`;
    assert.equal((await call(`${base}/journals`, { date: `${m}-15`, memo: 'Lab e2e sales', post: true, lines: [{ accountId: acc['1120'], debit: amount }, { accountId: acc['4100'], credit: amount }] })).status, 201);
  }

  await page.getByRole('link', { name: 'Forecast lab' }).click();
  await page.getByRole('heading', { name: 'Forecast evaluation lab' }).waitFor();
  const summary = page.getByTestId('lab-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /^Over the last 12 months, .* forecast revenue best, with an error of 0\.0% of the actual figures/);
  const methods = page.getByRole('table', { name: 'Method accuracy' });
  const first = methods.getByRole('row').nth(1);
  assert.match(await first.innerText(), /Straight-line trend|Last month plus trend/);
  assert.match(await first.innerText(), /Best/);
  // A method that needs a year of history before the first month checked is not ranked.
  assert.match(await methods.getByRole('row', { name: /Same month last year/ }).innerText(), /Needs at least 12 months of history/);
  // Next months from every method; the last month carried forward stays at 2,10,000.
  const ahead = page.getByRole('table', { name: 'Next three months' });
  assert.match(await ahead.getByRole('row').filter({ hasText: /^Last month/ }).filter({ hasNotText: 'plus trend' }).innerText(), /2,10,000\.00/);
  // The figures behind the chart.
  assert.equal(await page.getByRole('table', { name: 'Actual and forecast by month' }).getByRole('row').count(), 13);

  await page.getByLabel('Months checked').selectOption('6');
  await page.getByText('Checked on the last 6.').waitFor();
  await page.getByLabel('Figure', { exact: true }).selectOption('netCashFlow');
  await page.getByRole('heading', { name: 'Net cash flow' }).waitFor();
  assert.match(await summary.innerText(), /^Over the last 6 months/);

  await page.getByText('No saved forecast has reached its month yet.').waitFor();
  await page.getByLabel('Note for this run').fill('Before the budget meeting');
  await page.getByRole('button', { name: 'Save this run' }).click();
  await page.waitForURL(/\/forecast-lab\/runs\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Forecast run FL-0001' }).waitFor();
  await page.getByText('“Before the budget meeting”').waitFor();
  const rev = page.getByRole('table', { name: 'Revenue forecasts' });
  assert.equal(await rev.getByText('Not over yet').count(), 3);
  assert.match(await rev.getByRole('row').filter({ hasText: /^Last month/ }).filter({ hasNotText: 'plus trend' }).innerText(), /2,10,000\.00/);

  await page.getByRole('link', { name: 'Forecast lab' }).last().click();
  const saved = page.getByRole('table', { name: 'Saved runs' });
  await saved.waitFor();
  assert.match(await saved.innerText(), /FL-0001\s*Before the budget meeting/);
  assert.match(await saved.innerText(), /Not yet/);
  assert.deepEqual(consoleErrors.filter((e) => !/favicon/.test(e)), []);
});
