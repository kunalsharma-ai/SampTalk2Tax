/**
 * Dashboard performance budget (PERF-015) under the conditions written in perf/budgets.json: a
 * production build, Chromium at 1440x900 with no throttling, and one organisation with 120 posted
 * invoices, 40 posted bills and 20 customers over the current fiscal year. After one warm-up, each
 * interaction is timed five times, from the action until what it shows is on screen:
 *
 *   - opening the dashboard until the balances and the monthly chart show;
 *   - following "Owed to you · ageing" until the ageing ties to the ledger and lists customers;
 *   - going back until the dashboard's balances show again.
 *
 * The 95th percentile of each must be inside its budget. The timings are printed, and written as
 * JSON to $PERF_REPORT when set. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const BUDGETS = JSON.parse(readFileSync(new URL('../../../perf/budgets.json', import.meta.url), 'utf8')).budgets;
const limit = (key) => BUDGETS.find((b) => b.key === key).limitMs;
const RUNS = 5;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const FY_START = `${Number(T.slice(5, 7)) >= 4 ? T.slice(0, 4) : Number(T.slice(0, 4)) - 1}-04-01`;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const DAYS = Math.max(1, Math.round((Date.parse(`${T}T00:00:00Z`) - Date.parse(`${FY_START}T00:00:00Z`)) / 86_400_000)); // not money
let browser, page;
const consoleErrors = [];

async function call(path, body) {
  return page.evaluate(
    async ([u, b]) => {
      const r = await fetch(`/api/t2t${u}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}
const must = async (p) => {
  const r = await p;
  assert.ok(r.status < 300, JSON.stringify(r).slice(0, 300));
  return r.body;
};
/** Nearest-rank percentile. */
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the dashboard and its drill-down stay inside the performance budget', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Performance Owner');
  await page.getByLabel('Email').fill(`e2e-perf-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Performance Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const dashboardUrl = page.url();
  const B = `/v1/orgs/${dashboardUrl.split('/').pop()}`;

  // The data the budget is defined for.
  const acc = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customers = [];
  for (let i = 1; i <= 20; i++) customers.push((await must(call(`${B}/contacts`, { name: `Customer ${String(i).padStart(2, '0')}`, isCustomer: true }))).id);
  const vendors = [];
  for (let i = 1; i <= 5; i++) vendors.push((await must(call(`${B}/contacts`, { name: `Vendor ${i}`, isVendor: true }))).id);
  for (let i = 0; i < 120; i++) {
    const issueDate = addDays(FY_START, (i * 7) % DAYS);
    await must(
      call(`${B}/sales/documents`, {
        kind: 'INVOICE',
        contactId: customers[i % 20],
        issueDate,
        dueDate: addDays(issueDate, 30),
        post: true,
        lines: [{ accountId: acc['4100'], quantity: String(1 + (i % 4)), unitPrice: `${1000 + i * 37}.50` }],
      }),
    );
  }
  for (let i = 0; i < 40; i++) {
    const issueDate = addDays(FY_START, (i * 11) % DAYS);
    await must(
      call(`${B}/purchases/documents`, {
        kind: 'BILL',
        contactId: vendors[i % 5],
        issueDate,
        dueDate: addDays(issueDate, 30),
        reference: `PB-${i}`,
        post: true,
        lines: [{ accountId: acc['6400'], quantity: '1', unitPrice: `${500 + i * 13}.00` }],
      }),
    );
  }
  consoleErrors.length = 0;

  const dashboardReady = async () => {
    await page.getByRole('img', { name: /^Revenue, expenses and closing cash by period/ }).waitFor();
    await page.getByRole('link', { name: 'Owed to you · ageing' }).waitFor();
  };
  const ageingReady = async () => {
    await page.getByText('Ties to the general ledger').waitFor();
    await page.getByRole('button', { name: 'Show items for Customer 20' }).waitFor();
  };
  const timed = async (action, ready) => {
    const t0 = performance.now();
    await action();
    await ready();
    return Math.round(performance.now() - t0);
  };

  const open = [];
  const drill = [];
  const back = [];
  for (let run = 0; run <= RUNS; run++) {
    // A fresh page load each time (the "open" timing includes loading the app), then the two in-app steps.
    const o = await timed(() => page.goto(dashboardUrl), dashboardReady);
    const d = await timed(() => page.getByRole('link', { name: 'Owed to you · ageing' }).click(), ageingReady);
    const b = await timed(() => page.goBack(), dashboardReady);
    if (run === 0) continue; // warm-up
    open.push(o);
    drill.push(d);
    back.push(b);
  }

  const results = [
    { key: 'dashboard-open-p95', samples: open },
    { key: 'dashboard-drilldown-p95', samples: drill },
    { key: 'dashboard-back-p95', samples: back },
  ].map((r) => ({ ...r, p95: pct(r.samples, 95), limitMs: limit(r.key) }));
  for (const r of results) console.log(`${r.key}: p95 ${r.p95} ms (budget ${r.limitMs} ms), samples ${r.samples.join(', ')}`);
  if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, JSON.stringify({ at: new Date().toISOString(), runs: RUNS, results }, null, 2));
  for (const r of results) assert.ok(r.p95 <= r.limitMs, `${r.key}: p95 ${r.p95} ms is over the ${r.limitMs} ms budget`);
  assert.deepEqual(
    consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)),
    [],
  );
});
