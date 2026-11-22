/**
 * Browser end-to-end test for audit reports (RPT-021): a back-dated journal, a large round manual
 * journal that is then reversed; the report shows the journal checks, the
 * sensitive actions and activity by person, with the audit trail intact, and downloads as CSV.
 * Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const fiscalYear = (d) => (Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) + 1 : Number(d.slice(0, 4)));

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

test('the audit report shows journal checks, sensitive actions and activity, and downloads as CSV', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Asha Auditor');
  await page.getByLabel('Email').fill(`e2e-audit-report-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Audit Report Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const orgId = base.split('/orgs/')[1];
  const B = `/v1/orgs/${orgId}`;
  const back = addDays(T, -45);
  for (const fy of new Set([back, T].map(fiscalYear))) await call(`${B}/periods/fiscal-years`, { fiscalYear: fy });
  consoleErrors.length = 0; // the refused years log a 409 in the console; only the page's own errors count below
  const acc = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const journal = (date, amount, memo) => must(call(`${B}/journals`, { date, post: true, memo, lines: [{ accountId: acc['6600'], debit: amount }, { accountId: acc['1120'], credit: amount }] }));
  const late = await journal(back, '1200.00', 'Missed courier bill');
  const round = await journal(T, '250000.00', 'Year-end provision');
  await must(call(`${B}/journals/${round.id}/reverse`, { date: T, memo: 'Entered twice' }));

  await page.goto(`${base}/reports/audit`);
  await page.getByLabel('From', { exact: true }).fill(addDays(T, -1));
  await page.getByLabel('To', { exact: true }).fill(T);
  await Promise.all([page.waitForResponse((r) => r.url().includes(`/reports/audit?from=${addDays(T, -1)}`) && r.ok()), page.getByRole('button', { name: 'Show report' }).click()]);
  const checks = page.getByRole('table', { name: 'Journal checks' });
  await checks.waitFor();
  const rows = checks.locator('tbody tr');
  const num = (j) => `JE-${String(j.entryNumber).padStart(6, '0')}`;
  assert.equal(await rows.count(), 4);
  assert.match(await rows.first().innerText(), new RegExp(`Posted long after its date[\\s\\S]*${num(late)}[\\s\\S]*1,200\\.00[\\s\\S]*posted 45 days later`));
  assert.match(await rows.nth(1).innerText(), new RegExp(`Large round manual journal[\\s\\S]*${num(round)}[\\s\\S]*2,50,000\\.00`));
  assert.match(await rows.nth(2).innerText(), /Prepared and posted by one person/);
  const sensitive = await page.getByRole('table', { name: 'Sensitive actions' }).innerText();
  assert.match(sensitive, /Voids, reversals and cancellations[\s\S]*journal\.reversed[\s\S]*Asha Auditor/);
  assert.match(await page.getByRole('table', { name: 'Activity by person' }).innerText(), /Asha Auditor\s+\d+\s+\d+/);
  assert.equal(await page.getByText('Intact', { exact: true }).count(), 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/audit-report.png`, fullPage: true });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download audit report (CSV)' }).click()]);
  assert.equal(download.suggestedFilename(), `audit-report-${addDays(T, -1)}-to-${T}.csv`);
  assert.deepEqual(consoleErrors, []);
});
