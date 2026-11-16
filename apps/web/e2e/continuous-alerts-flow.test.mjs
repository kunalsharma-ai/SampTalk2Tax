/**
 * Browser end-to-end test for prioritised alerts and the work queue: an owner sets a minimum
 * cash balance the business cannot meet, opens Alerts and sees the critical alert ranked first
 * with its score explained, finds its task in the work queue filtered to alerts, changes the
 * task setting, then dismisses the alert and sees the task cancelled by itself.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, orgId, base, accounts;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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

test('a critical alert is ranked first, becomes a task, and the task closes when the alert is dismissed', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Queue Owner');
  await page.getByLabel('Email').fill(`e2e-queue-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Queue Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const fy = +T.slice(0, 4) + (+T.slice(5, 7) >= 4 ? 1 : 0);
  const have = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!have.has(fy - 1)) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fy - 1 })).status, 201);
  assert.equal((await call(`${base}/journals`, { date: addDays(T, -20), post: true, memo: 'Capital', lines: [{ accountId: accounts['1120'], debit: '300000.00' }, { accountId: accounts['3100'], credit: '300000.00' }] })).status, 201);
  assert.equal((await call(`${base}/cash-flow/settings`, { minimumBalance: '50000000' }, 'PUT')).status, 200);

  // The setting starts at critical alerts for the owners.
  await page.goto(`${WEB}/orgs/${orgId}/alerts/settings`);
  const setting = page.getByRole('region', { name: 'Tasks from alerts' });
  await setting.getByText('Default setting').waitFor();
  assert.equal(await setting.getByLabel('Make a task for').inputValue(), 'CRITICAL');
  assert.equal(await setting.getByLabel('Give it to').inputValue(), 'OWNER');

  // Alerts: the dashboard already ran the checks before the cash setting, so run them again.
  await page.goto(`${WEB}/orgs/${orgId}/alerts`);
  await page.getByRole('button', { name: 'Run checks now' }).click();
  await page.getByRole('status').getByText(/^Checks finished/).waitFor();
  const list = page.getByRole('list', { name: 'Alerts' });
  await list.waitFor();
  const first = list.getByRole('listitem').first();
  await first.getByText(/^Cash expected below the minimum balance/).waitFor();
  // Critical (60) and money at stake with no revenue yet to judge it against (8).
  assert.match(await first.innerText(), /Priority\s+High ·\s+68/);
  await page.getByText(/^Most urgent first:/).waitFor();
  await first.getByRole('button').click();
  const dialog = page.getByRole('dialog');
  const why = dialog.getByRole('region', { name: 'Priority' });
  await why.getByText('Priority: High, 68 of 100').waitFor();
  await why.getByText('Critical (60)').waitFor();
  await why.getByText('Amount at stake, with no revenue to compare it with (8)').waitFor();
  await page.keyboard.press('Escape');

  // The work queue, filtered to alerts, has the task.
  await page.goto(`${WEB}/orgs/${orgId}/tasks`);
  await page.getByLabel('Tasks from').selectOption('ALERT');
  const task = page.getByRole('list', { name: 'Tasks' }).getByRole('listitem').first();
  await task.getByText(/^Critical alert: Cash expected below the minimum balance/).waitFor();
  assert.match(await task.innerText(), /An alert/);
  assert.match(await task.innerText(), /From an alert/);
  await page.getByLabel('Tasks from').selectOption('WORKFLOW');
  await page.getByText('None from here. Choose “Anywhere” to see every task.').waitFor();

  // Warnings too, for the accountants, due in 2 days.
  await page.goto(`${WEB}/orgs/${orgId}/alerts/settings`);
  await setting.getByLabel('Make a task for').selectOption('WARNING');
  await setting.getByLabel('Give it to').selectOption('ACCOUNTANT');
  await setting.getByLabel('Due after (days)').fill('45');
  await setting.getByText('A whole number from 0 to 30').waitFor();
  assert.equal(await setting.getByRole('button', { name: 'Save' }).isDisabled(), true);
  await setting.getByLabel('Due after (days)').fill('2');
  await setting.getByRole('button', { name: 'Save' }).click();
  await setting.getByRole('status').getByText('Saved').waitFor();
  await setting.getByText(/^Changed .* by Queue Owner/).waitFor();
  const saved = (await call(`${base}/alerts/notifications`)).body;
  assert.deepEqual([saved.minSeverity, saved.taskRole, saved.dueDays], ['WARNING', 'ACCOUNTANT', 2]);

  // Dismissing the alert cancels its task by itself.
  await page.goto(`${WEB}/orgs/${orgId}/alerts`);
  await list.getByRole('listitem').first().getByRole('button').click();
  await dialog.getByRole('button', { name: 'Dismiss…' }).click();
  await dialog.getByLabel('Why is this not a problem?').fill('Minimum balance is a placeholder');
  await dialog.getByRole('button', { name: 'Dismiss alert' }).click();
  await dialog.getByRole('region', { name: 'Priority' }).getByText('Priority: Low, 0 of 100').waitFor();
  await page.keyboard.press('Escape');
  await page.goto(`${WEB}/orgs/${orgId}/tasks`);
  await page.getByRole('tab', { name: 'Cancelled' }).click();
  const cancelled = page.getByRole('list', { name: 'Tasks' }).getByRole('listitem').first();
  await cancelled.getByText(/^Critical alert: Cash expected below/).waitFor();
  assert.match(await cancelled.innerText(), /Cancelled by Queue Owner: The alert was dismissed: Minimum balance is a placeholder/);

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
