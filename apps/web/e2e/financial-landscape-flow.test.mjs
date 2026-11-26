/**
 * Browser end-to-end test for the financial landscape (DASH-023): an owner opens Reports →
 * Financial landscape, sees spending by account and month as towers, turns the landscape with
 * the keyboard, steps and plays the months, picks out one tower from the table and opens its
 * ledger, then switches to income. Real Next.js app → real API → real MongoDB.
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
// Today in India, the organisation's time zone; every journal is dated today.
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner turns and plays the landscape of spending and income', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Landscape');
  await page.getByLabel('Email').fill(`e2e-landscape-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Landscape Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const journal = async (dr, cr, amount, memo) =>
    ok(
      await call(`${base}/journals`, {
        date: T,
        memo,
        post: true,
        lines: [
          { accountId: acc[dr], debit: amount },
          { accountId: acc[cr], credit: amount },
        ],
      }),
      memo,
    );
  await journal('6100', '1120', '90000.00', 'Salaries');
  await journal('6200', '1120', '30000.00', 'Rent');
  await journal('1120', '4100', '300000.00', 'Sales');
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}`);
  await page.getByRole('link', { name: 'Financial landscape' }).click();
  await page.getByRole('heading', { name: 'Financial landscape', exact: true }).waitFor();
  const land = page.getByRole('region', { name: 'Landscape', exact: true });
  await land.getByRole('img', { name: /^Spending by account and month as a landscape of towers/ }).waitFor();
  const summary = page.getByRole('region', { name: 'Landscape summary' });
  await summary.getByText('₹1,20,000.00', { exact: true }).first().waitFor();
  await summary.getByText(`6100 Salaries and Wages, ${label(T.slice(0, 7))}`, { exact: true }).waitFor();
  const month = label(T.slice(0, 7));
  assert.equal(await page.getByTestId('landscape-month').textContent(), month);
  const table = page.getByRole('table', { name: 'Spending by account and month' });
  const rows = (await table.locator('tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.equal(rows.length, 3);
  assert.ok(rows[0].startsWith('6100 Salaries and Wages') && rows[0].endsWith('₹90,000.00 ₹90,000.00'), rows[0]);
  assert.ok(rows[1].startsWith('6200 Rent') && rows[1].endsWith('₹30,000.00 ₹30,000.00'), rows[1]);
  assert.ok(rows[2].startsWith('Total') && rows[2].endsWith('₹1,20,000.00 ₹1,20,000.00'), rows[2]);
  if (SHOTS) await land.screenshot({ path: `${SHOTS}/financial-landscape.png` });

  // Turn it with the keyboard: the drawing changes; Reset view puts it back.
  const shape = () => land.locator('svg polygon').nth(1).getAttribute('points');
  const before = await shape();
  await land.getByRole('group', { name: /^Turn the landscape/ }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  assert.notEqual(await shape(), before);
  await land.getByRole('button', { name: 'Reset view' }).click();
  assert.equal(await shape(), before);

  // Step back a month with the slider, then play and pause.
  const slider = land.getByRole('slider', { name: 'Show months up to' });
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  assert.notEqual(await page.getByTestId('landscape-month').textContent(), month);
  await page.keyboard.press('End');
  assert.equal(await page.getByTestId('landscape-month').textContent(), month);
  await land.getByRole('button', { name: 'Play months' }).click();
  await page.waitForFunction((m) => document.querySelector('[data-testid="landscape-month"]')?.textContent !== m, month);
  await land.getByRole('button', { name: 'Pause' }).click();

  // Pick out the rent tower for this month and open its ledger.
  const rent = table.getByRole('button', { name: `6200 Rent, ${month}`, exact: true });
  await rent.click();
  assert.equal(await rent.getAttribute('aria-pressed'), 'true');
  await table.getByRole('link', { name: 'Ledger', exact: true }).click();
  await page.waitForURL(new RegExp(`/reports/general-ledger\\?accountId=${acc['6200']}&from=${T.slice(0, 7)}-01`));
  await page.goBack();

  // Income shows the sales account.
  await page.getByRole('heading', { name: 'Financial landscape', exact: true }).waitFor();
  await page.getByLabel('Show', { exact: true }).selectOption('REVENUE');
  const income = page.getByRole('table', { name: 'Income by account and month' });
  await income.getByRole('rowheader', { name: '4100 Sales Revenue' }).waitFor();
  await page.getByRole('region', { name: 'Landscape summary' }).getByText('₹3,00,000.00', { exact: true }).first().waitFor();

  assert.deepEqual(consoleErrors, []);
});
