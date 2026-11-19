/**
 * Browser end-to-end test for starting the month-end close automatically (WFLOW-021): an owner
 * turns it on from the Month-end close page, and the close runner starts last month's close in
 * their name with tasks for open checks, shown on the month's page as started automatically.
 * Real Next.js app → real API (close runner every second in CI) → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));

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
after(async () => {
  await browser?.close();
});

test('an owner turns on automatic starting and last month\'s close starts on its own', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Auto Close Owner');
  await page.getByLabel('Email').fill(`e2e-autoclose-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Auto Close Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const M = shift(T.slice(0, 7), -1);
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!years.has(fyOf(M))) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(M) })).status, 201);
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  // A draft journal leaves a blocking check open, so a task is made for it.
  assert.equal((await call(`${base}/journals`, { date: `${M}-10`, memo: 'Draft sale', post: false, lines: [{ accountId: acc['1120'], debit: '1000.00' }, { accountId: acc['4100'], credit: '1000.00' }] })).status, 201);

  await page.getByRole('link', { name: 'Month-end close', exact: true }).click();
  await page.getByRole('heading', { name: 'Month-end close', exact: true }).waitFor();
  const card = page.getByRole('region', { name: 'Start automatically' });
  await card.getByText(/Off: a person starts each close/).waitFor();
  await card.getByLabel('Start each close when the month ends').check();
  await card.getByRole('button', { name: 'Save' }).click();
  await card.getByText(/On: the day after a month ends its close starts on its own, in the name of Auto Close Owner, with tasks/).waitFor();
  await card.getByText(/Last changed by Auto Close Owner/).waitFor();

  const name = (await call(`${base}/close`)).body.periods.find((p) => p.startDate === `${M}-01`).name;
  const row = page.getByRole('row', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  for (let i = 0; i < 30; i++) {
    const list = (await call(`${base}/close`)).body.periods;
    if (list.find((p) => p.startDate === `${M}-01`).closeStatus === 'IN_PROGRESS') break;
    await page.waitForTimeout(500);
  }
  await page.reload();
  await row.getByText('In progress').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/close-auto-start.png` });

  await row.getByRole('link', { name }).click();
  await page.getByRole('heading', { name: `${name} close` }).waitFor();
  await page.getByText('Started automatically for Auto Close Owner').waitFor();
  const tasks = (await call(`${base}/tasks?scope=all`)).body;
  assert.ok(tasks.tasks.some((t) => /close: no draft journals in the month$/.test(t.title)), 'a task for the open check');
  assert.deepEqual(consoleErrors, []);
});
