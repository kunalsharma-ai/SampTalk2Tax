/**
 * Browser end-to-end test for the year-end close: an owner closes last year's profit to retained
 * earnings after checking the closing journal, opens it, closes again after a late adjustment
 * (only the difference), and reopens the year. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page, orgId;
const consoleErrors = [];

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
after(async () => browser?.close());

test('a year is closed to retained earnings, closed again after a late change, and reopened', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Year End Owner');
  await page.getByLabel('Email').fill(`e2e-year-end-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Year End Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/orgs/')[1];
  const base = `/v1/orgs/${orgId}`;
  const current = (await call(`${base}/periods`)).body[0].fiscalYear;
  const made = await call(`${base}/periods/fiscal-years`, { fiscalYear: current - 1 });
  assert.equal(made.status, 201);
  const start = made.body[0].startDate;
  const end = made.body.at(-1).endDate;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const journal = async (d, debit, credit, amount, memo) => {
    const r = await call(`${base}/journals`, { date: d, post: true, memo, lines: [{ accountId: acc[debit], debit: amount }, { accountId: acc[credit], credit: amount }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  await journal(`${start.slice(0, 8)}20`, '1120', '4100', '250000.00', 'Sales');
  await journal(`${end.slice(0, 8)}05`, '6200', '1120', '90000.00', 'Rent');
  const label = `FY ${start.slice(0, 4)}-${end.slice(2, 4)}`;

  await page.goto(`${WEB}/orgs/${orgId}/year-end`);
  await page.getByRole('heading', { name: 'Year-end close' }).waitFor();
  const years = page.getByRole('table', { name: 'Fiscal years' });
  const row = years.getByRole('row', { name: new RegExp(label) });
  await row.getByText('Not closed').waitFor();
  assert.match(await row.innerText(), /1,60,000\.00/);
  await row.getByRole('button', { name: 'Close the year…' }).click();
  const dialog = page.getByRole('dialog', { name: `Close ${label}` });
  const lines = dialog.getByRole('table', { name: 'Closing journal' });
  await lines.getByRole('row', { name: /4100 · Sales Revenue.*2,50,000\.00/ }).waitFor();
  await lines.getByRole('row', { name: /6200 · Rent.*90,000\.00/ }).waitFor();
  await lines.getByRole('row', { name: /3200 · Retained Earnings.*1,60,000\.00/ }).waitFor();
  await dialog.getByLabel('Note (optional)').fill('Books final after audit');
  await dialog.getByRole('button', { name: 'Close the year' }).click();
  await page.getByText(`YE-0001: ${label} closed`).waitFor();
  await row.getByText('Closed', { exact: true }).waitFor();

  // The closing journal explains itself; the year's profit is still reported.
  await page.getByRole('link', { name: 'Open the closing journal' }).click();
  await page.getByText('Created by the year-end close').waitFor();
  const pl = (await call(`${base}/reports/income-statement?from=${start}&to=${end}`)).body;
  assert.equal(pl.netIncome, '160000.00');
  const bs = (await call(`${base}/reports/balance-sheet?asOf=${end}`)).body;
  assert.equal(bs.unclosedEarnings, '0.00');
  assert.equal(bs.equity.find((e) => e.code === '3200').amount, '160000.00');

  // A late adjustment: only the difference is closed.
  await journal(end, '6200', '1120', '10000.00', 'Late rent');
  await page.goto(`${WEB}/orgs/${orgId}/year-end`);
  await row.getByText('Changed since closing').waitFor();
  await row.getByRole('button', { name: 'Close again…' }).click();
  const again = page.getByRole('dialog', { name: `Close ${label}` });
  await again.getByRole('table', { name: 'Closing journal' }).getByRole('row', { name: /3200 · Retained Earnings.*10,000\.00/ }).waitFor();
  assert.equal(await again.getByRole('table', { name: 'Closing journal' }).getByRole('row').count(), 3);
  await again.getByRole('button', { name: 'Close the year' }).click();
  await page.getByText(`YE-0002: ${label} closed`).waitFor();
  const closes = page.getByRole('table', { name: 'Closes made' });
  await closes.getByRole('row', { name: /YE-0002.*Books final|YE-0002/ }).waitFor();

  // Reopen the year: both closes are reversed.
  await row.getByRole('button', { name: 'Reopen…' }).click();
  await page.getByLabel('Reason').fill('Restating after the audit');
  await page.getByRole('button', { name: 'Reopen the year' }).click();
  await row.getByText('Not closed').waitFor();
  assert.equal(await closes.getByText('Reversed').count(), 2);
  assert.equal((await call(`${base}/reports/balance-sheet?asOf=${end}`)).body.unclosedEarnings, '150000.00');

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
