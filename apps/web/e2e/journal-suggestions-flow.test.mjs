/**
 * Browser end-to-end test for automated journal suggestions (GL-036): an owner opens Journal
 * suggestions for last month, sees a rent journal missed and utilities to accrue, saves the
 * accrual as a draft journal, and dismisses the rent with a reason.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
let browser, page;
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
const addMonths = (month, by) => {
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
});

test('an owner accepts and dismisses journal suggestions', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Suggestions Owner');
  await page.getByLabel('Email').fill(`e2e-suggest-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const M = addMonths(today.slice(0, 7), -1);
  const E = [-3, -2, -1].map((i) => addMonths(M, i));
  // A fiscal year starting five months back covers the three months before last month.
  const org = (await call('/v1/orgs', { name: 'E2E Suggest Co', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: Number(addMonths(today.slice(0, 7), -5).slice(5, 7)) })).body;
  const acc = Object.fromEntries((await call(`/v1/orgs/${org.id}/accounts`)).body.map((a) => [a.code, a.id]));
  const post = async (date, d, c, amount, memo) => assert.equal((await call(`/v1/orgs/${org.id}/journals`, { date, post: true, memo, lines: [{ accountId: acc[d], debit: amount }, { accountId: acc[c], credit: amount }] })).status, 201);
  await post(`${E[0]}-01`, '1120', '3100', '500000.00', 'Capital');
  for (const m of E) await post(`${m}-05`, '6200', '1120', '50000.00', 'Office rent');
  await post(`${E[0]}-20`, '6300', '1120', '3000.00', 'Power');
  await post(`${E[1]}-20`, '6300', '1110', '3500.00', 'Power, paid in cash');
  await post(`${E[2]}-20`, '6300', '1120', '4100.00', 'Power');

  await page.goto(`${WEB}/orgs/${org.id}`);
  await page.getByRole('link', { name: 'Journal suggestions', exact: true }).click();
  await page.waitForURL(/journal-suggestions$/);
  assert.equal(await page.getByLabel('Month', { exact: true }).inputValue(), M);
  const list = page.getByRole('list', { name: 'Suggested journals' });
  await list.getByText('Office rent', { exact: true }).waitFor();
  await list.getByText('Accrue Utilities').waitFor();
  assert.match(await page.getByRole('listitem', { name: 'Accrue Utilities' }).innerText(), /₹3,533\.33[\s\S]*6300 Utilities[\s\S]*2200 Accrued Liabilities/);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/journal-suggestions.png`, fullPage: true });
  }

  // Accept the accrual: a draft journal.
  await page.getByRole('listitem', { name: 'Accrue Utilities' }).getByRole('button', { name: 'Save as draft journal' }).click();
  await page.getByText('Saved as a draft journal').waitFor();
  await list.getByText('Accrue Utilities').waitFor({ state: 'detached' });
  const decisions = page.getByRole('table', { name: 'Decisions this month' });
  await decisions.getByText('Draft journal').waitFor();

  // Dismiss the rent with a reason.
  await page.getByRole('listitem', { name: 'Office rent' }).getByRole('button', { name: 'Dismiss…' }).click();
  await page.getByLabel('Why dismiss it?').fill('Rent is paid quarterly now');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByText('Nothing to suggest').waitFor();
  assert.match(await decisions.innerText(), /Office rent[\s\S]*Dismissed[\s\S]*Rent is paid quarterly now/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/journal-suggestions-decided.png`, fullPage: true });

  // The draft journal is there to check and post.
  await decisions.getByRole('link', { name: 'Draft journal' }).click();
  await page.waitForURL(/journals\/[0-9a-f-]{36}$/);
  await page.getByText(/Accrual: Utilities/).first().waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
