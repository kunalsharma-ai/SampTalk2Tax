/**
 * Browser end-to-end test for journal templates and recurring journals: an owner saves a monthly
 * rent template with a month-end schedule that posts, runs the runs already due (posted journals
 * with the month in the memo), uses the template by hand for a draft, saves a manual journal as a
 * second template, pauses and resumes skipping missed runs, and archives a template.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const monthEnd = (iso, add = 0) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m + add, 0)).toISOString().slice(0, 10);
};
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

test('a recurring journal posts its due runs, and templates are used by hand', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Templates Owner');
  await page.getByLabel('Email').fill(`e2e-templates-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Templates Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/orgs/')[1];
  const periods = (await call(`/v1/orgs/${orgId}/periods`)).body;
  const fyStart = periods.map((p) => p.startDate).sort()[0];
  // The first run: two month ends ago, or the first month end of the fiscal year.
  let start = monthEnd(T, -2);
  if (start < fyStart) start = monthEnd(fyStart);
  let due = 0;
  for (let d = start; d <= T; d = monthEnd(d, 1)) due++;

  // A new template from the menu.
  await page.goto(`${WEB}/orgs/${orgId}/journal-templates`);
  await page.getByRole('heading', { name: 'Journal templates' }).waitFor();
  await page.getByRole('button', { name: 'New template' }).click();
  await page.waitForURL(/journal-templates\/new$/);
  await page.getByLabel('Name').fill('Office rent');
  await page.getByLabel('Memo').fill('Rent for {month}');
  await page.getByLabel('Account for line 1').selectOption({ label: '6200 · Rent' });
  await page.getByLabel('Debit for line 1').fill('85000');
  await page.getByLabel('Account for line 2').selectOption({ label: '2200 · Accrued Liabilities' });
  await page.getByLabel('Credit for line 2').fill('85000');
  await page.getByText('✓ Balanced').waitFor();
  await page.getByLabel('Make this journal on a schedule').check();
  await page.getByLabel('First run').fill(start);
  await page.getByLabel("On the month's last day").check();
  await page.getByLabel('Posts the journal straight away').check();
  await page.getByText(`${due} run${due === 1 ? '' : 's'} already fell due`).waitFor();
  await page.getByRole('button', { name: 'Save template' }).click();
  await page.waitForURL(/journal-templates\/[0-9a-f-]{36}$/);
  const templateUrl = page.url();
  await page.getByRole('heading', { name: 'JT-0001 · Office rent' }).waitFor();
  await page.getByText('Recurring · posts').first().waitFor();
  assert.equal(await page.getByRole('table', { name: 'Upcoming runs' }).getByText('Due').count(), due);

  // Run due now posts every run that has fallen due.
  await page.getByRole('button', { name: 'Run due now' }).click();
  await page.getByText(`${due} ${due === 1 ? 'journal' : 'journals'} made`).waitFor();
  const made = page.getByRole('table', { name: 'Journals made' });
  assert.equal(await made.getByText('Posted').count(), due);
  const month = new Date(`${start}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  await made.getByText(`Rent for ${month}`).waitFor();
  // Running again makes nothing more.
  await page.getByRole('button', { name: 'Run due now' }).click();
  await page.getByText('Nothing was due').waitFor();

  // Open a journal the schedule posted.
  await made.getByRole('link', { name: /^JE-/ }).last().click();
  await page.waitForURL(/journals\/[0-9a-f-]{36}$/);
  await page.getByText(`Rent for ${month}`).first().waitFor();
  await page.getByText('Posted', { exact: true }).waitFor();

  // Use the template by hand: a draft dated today.
  await page.goto(templateUrl);
  await page.getByRole('button', { name: 'Use template…' }).click();
  await page.getByRole('dialog').getByLabel('Journal date').fill(T);
  await page.getByRole('button', { name: 'Make a draft' }).click();
  await page.waitForURL(/journals\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Draft journal' }).waitFor();

  // Save that journal as a second template.
  await page.getByRole('button', { name: 'Save as template…' }).click();
  await page.getByLabel('Template name').fill('Rent copy');
  await page.getByRole('dialog').getByRole('button', { name: 'Save template' }).click();
  await page.waitForURL(/journal-templates\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'JT-0002 · Rent copy' }).waitFor();
  // Unused, so it can be deleted outright.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(/journal-templates$/);

  // Pause, then resume from today skipping missed runs.
  await page.goto(templateUrl);
  await page.getByRole('button', { name: 'Pause schedule' }).click();
  await page.getByText('Paused').first().waitFor();
  await page.getByRole('button', { name: 'Resume…' }).click();
  await page.getByRole('button', { name: 'Resume from today, skipping missed runs' }).click();
  await page.getByText('Recurring · posts').first().waitFor();
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByText('Archived').first().waitFor();
  await page.getByRole('button', { name: 'Restore' }).waitFor();

  // The list shows the template under All templates.
  await page.goto(`${WEB}/orgs/${orgId}/journal-templates`);
  await page.getByLabel('Show').selectOption('all');
  await page.getByRole('table', { name: 'Journal templates' }).getByRole('link', { name: 'JT-0001' }).waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
