/**
 * Browser end-to-end test for the scenario surface (DASH-027, DASH-039): an owner opens the
 * digital twin, goes to the scenario surface, draws net profit for price against payroll,
 * reads the best and worst points, turns the surface with the keyboard, plays the months, marks
 * a value from the table, and is told in words when both changes are the same.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const ok = (r, what) => {
  assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
// Last month in India, the organisation's time zone.
const now = new Date(Date.now() + 5.5 * 3_600_000);
const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 10);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner explores price against payroll as a surface', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Surface');
  await page.getByLabel('Email').fill(`e2e-surface-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Surface Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const periods = ok(await call(`${base}/periods`), 'periods');
  if (!periods.some((p) => p.startDate <= last)) await call(`${base}/periods/fiscal-years`, { fiscalYear: Number(periods[0].startDate.slice(0, 4)) - 1 });
  // Last month: revenue 300,000, cost of sales 120,000, salaries 90,000, rent 30,000.
  for (const [dr, cr, amount, memo] of [
    ['1120', '3100', '1000000.00', 'Capital'],
    ['1120', '4100', '300000.00', 'Sales'],
    ['5000', '1120', '120000.00', 'Stock sold'],
    ['6100', '1120', '90000.00', 'Salaries'],
    ['6200', '1120', '30000.00', 'Rent'],
  ]) {
    ok(
      await call(`${base}/journals`, {
        date: last,
        memo,
        post: true,
        lines: [
          { accountId: acc[dr], debit: amount },
          { accountId: acc[cr], credit: amount },
        ],
      }),
      memo,
    );
  }
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/planning/twin`);
  await page.getByRole('link', { name: 'Scenario surface' }).click();
  await page.getByRole('heading', { name: 'Scenario surface', exact: true }).waitFor();
  const settings = page.getByRole('region', { name: 'Surface settings' });
  await settings.getByLabel('Months ahead').fill('2');
  await settings.getByLabel('Actual months to start from').selectOption('3');
  await settings.getByLabel('Across: from').fill('-10');
  await settings.getByLabel('Across: to').fill('10');
  await settings.getByLabel('Across: points').fill('3');
  await settings.getByLabel('Back: from').fill('-10');
  await settings.getByLabel('Back: to').fill('10');
  await settings.getByLabel('Back: points').fill('3');
  await settings.getByRole('button', { name: 'Draw the surface' }).click();

  // Averaged over three months: profit 20,000 a month. Price moves it 10,000 a month, payroll 3,000.
  const summary = page.getByRole('region', { name: 'Surface summary' });
  await summary.getByText('₹40,000.00', { exact: true }).waitFor();
  await summary.getByText('₹66,000.00', { exact: true }).waitFor();
  await summary.getByText('+10% · -10%', { exact: true }).waitFor();
  await summary.getByText('₹14,000.00', { exact: true }).waitFor();
  await summary.getByText('0 of 9', { exact: true }).waitFor();
  const surface = page.getByRole('region', { name: 'Scenario surface' });
  await surface.getByRole('img', { name: /^Net profit so far by price change and payroll change in \d{4}-\d{2}, drawn as a surface/ }).waitFor();
  if (SHOTS) await surface.screenshot({ path: `${SHOTS}/scenario-surface.png` });

  // Turn it with the keyboard: the drawing changes.
  const before = await surface.locator('svg polygon').nth(2).getAttribute('points');
  await surface.getByRole('group', { name: /^Turn the surface/ }).focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowUp');
  assert.notEqual(await surface.locator('svg polygon').nth(2).getAttribute('points'), before);

  // The first month, then play and pause.
  const month = page.getByTestId('surface-month');
  const lastFrame = await month.textContent();
  await surface.getByLabel('Projected month to show').fill('0');
  assert.notEqual(await month.textContent(), lastFrame);
  const values = page.getByRole('region', { name: 'Surface values' });
  await values.getByRole('button', { name: 'Price change +10%, Payroll change -10%' }).getByText('₹33,000.00').waitFor();
  await surface.getByRole('button', { name: 'Play months' }).click();
  await page.waitForFunction((t) => document.querySelector('[data-testid="surface-month"]')?.textContent === t, lastFrame);
  await surface.getByRole('button', { name: 'Pause' }).click();

  // Mark a value from the table on the surface.
  const cell = values.getByRole('button', { name: 'Price change -10%, Payroll change +10%' });
  await cell.click();
  assert.equal(await cell.getAttribute('aria-pressed'), 'true');
  await surface.locator('svg circle').waitFor();

  // Both changes the same: told what to fix.
  await settings.getByLabel('Back: change').selectOption('PRICE');
  await settings.getByRole('button', { name: 'Draw the surface' }).click();
  await settings.getByText('Choose two different changes', { exact: true }).waitFor();
  assert.deepEqual(
    consoleErrors.filter((e) => !/422|Failed to load resource/.test(e)),
    [],
  );
});
