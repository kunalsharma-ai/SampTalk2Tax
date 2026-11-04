/**
 * Browser end-to-end test for the financial digital twin: an owner posts a month of activity,
 * starts a scenario from the "Hire a team" template, edits it and watches the projection
 * change, adds the tax rate it asks for, saves, reopens and compares it with no change, and
 * the books are untouched. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, orgId, base, accounts;
const consoleErrors = [];
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  const y = +month.slice(0, 4) + Math.floor(m / 12);
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const label = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

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
  page.on('dialog', (d) => d.accept());
});
after(async () => browser?.close());

test('a what-if scenario is built from a template, played forward, saved and compared, and nothing is posted', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Twin Owner');
  await page.getByLabel('Email').fill(`e2e-twin-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Twin Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const now = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7);
  const last = shift(now, -1);
  const have = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const m of [last, now]) {
    const fy = +m.slice(0, 4) + (+m.slice(5, 7) >= 4 ? 1 : 0);
    if (!have.has(fy)) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fy })).status, 201), have.add(fy);
  }
  const post = async (debit, credit, amount, memo) =>
    assert.equal((await call(`${base}/journals`, { date: `${last}-15`, post: true, memo, lines: [{ accountId: accounts[debit], debit: amount }, { accountId: accounts[credit], credit: amount }] })).status, 201);
  await post('1120', '3100', '1000000.00', 'Capital');
  await post('1120', '4100', '300000.00', 'Sales');
  await post('5000', '1120', '120000.00', 'Stock sold');
  await post('6100', '1120', '90000.00', 'Salaries');
  await post('6200', '1120', '30000.00', 'Rent');
  const journalsBefore = (await call(`${base}/journals?limit=100`)).body;
  const countBefore = (Array.isArray(journalsBefore) ? journalsBefore : journalsBefore.items).length;

  await page.getByRole('link', { name: 'Digital twin', exact: true }).click();
  await page.getByText('No scenarios yet').waitFor();
  const hire = page.getByRole('list', { name: 'Templates' }).getByRole('listitem').filter({ hasText: 'Hire a team' });
  await hire.getByRole('link', { name: 'Use this template' }).click();
  await page.getByRole('heading', { name: 'New scenario: Hire a team' }).waitFor();
  assert.equal(await page.getByLabel('Name').inputValue(), 'Hire a team');
  await page.getByLabel('Baseline').selectOption('3');

  const change = page.getByRole('listitem', { name: 'Change 1: Hiring' });
  assert.equal(await change.getByLabel('People').inputValue(), '5');
  const table = page.getByRole('table', { name: 'Projection by month' });
  const m2 = shift(last, 2);
  // Five at 60,000 plus 25,000 each once: payroll 3,30,000 in the second month.
  await table.getByRole('row', { name: new RegExp(label(m2)) }).getByText('₹3,30,000.00').waitFor();
  await change.getByLabel('People').fill('2');
  await change.getByLabel('Monthly cost each').fill('50000');
  await change.getByLabel('One-off cost each').fill('10000');
  // Baseline payroll 30,000 + 2 × 50,000; the 20,000 one-off cost goes through profit too.
  await table.getByRole('row', { name: new RegExp(label(m2)) }).getByText('₹1,30,000.00').waitFor();
  await table.getByRole('row', { name: new RegExp(label(m2)) }).getByText('₹9,80,000.00').waitFor();
  assert.equal(await change.getByLabel('From month').inputValue(), '2');
  await page.getByRole('list', { name: 'Assumptions' }).getByText(/^2 people join in/).waitFor();

  // The twin asks for the tax rate; adding it taxes the first month's 20,000 profit.
  const ask = page.getByRole('list', { name: 'Inputs to confirm' }).getByRole('listitem').filter({ hasText: /tax/i });
  await ask.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('listitem', { name: 'Change 2: Income tax rate' }).getByLabel('Rate (%)').waitFor();
  await table.getByRole('row', { name: new RegExp(label(shift(last, 1))) }).getByText('₹5,000.00').waitFor();

  await page.getByLabel('Name').fill('Hire two engineers');
  await page.getByRole('button', { name: 'Save scenario' }).click();
  await page.waitForURL(/\/planning\/twin\/[0-9a-f-]{36}$/);
  const scenarioId = page.url().split('/').pop();
  await page.getByRole('heading', { name: 'Hire two engineers' }).waitFor();
  await page.reload();
  await page.getByRole('listitem', { name: 'Change 1: Hiring' }).waitFor();
  assert.equal(await page.getByRole('listitem', { name: 'Change 1: Hiring' }).getByLabel('People').inputValue(), '2');
  await page.getByRole('listitem', { name: 'Change 2: Income tax rate' }).waitFor();
  const saved = (await call(`${base}/twin/scenarios/${scenarioId}`)).body;
  assert.deepEqual(
    saved.scenario.drivers.map((d) => d.kind),
    ['HIRING', 'TAX_RATE'],
  );
  assert.equal(saved.result.projection.months[1].payroll, '130000.00');

  await page.getByLabel('Horizon').selectOption('6');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  assert.equal((await call(`${base}/twin/scenarios/${scenarioId}`)).body.scenario.horizonMonths, 6);

  await page.getByRole('link', { name: 'All scenarios' }).click();
  await page.getByRole('checkbox', { name: 'Compare Hire two engineers' }).check();
  await page.getByRole('button', { name: 'Compare 1 with no change' }).click();
  await page.waitForURL(/\/planning\/twin\/compare\?ids=/);
  const cmp = page.getByRole('table', { name: 'Scenario comparison' });
  await cmp.getByRole('row', { name: /No change \(baseline\)/ }).getByText('Most profitable').waitFor();
  await cmp.getByRole('row', { name: /Hire two engineers/ }).waitFor();

  const journalsAfter = (await call(`${base}/journals?limit=100`)).body;
  assert.equal((Array.isArray(journalsAfter) ? journalsAfter : journalsAfter.items).length, countBefore, 'the twin never posts to the books');
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
