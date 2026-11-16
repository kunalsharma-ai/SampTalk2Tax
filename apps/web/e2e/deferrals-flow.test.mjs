/**
 * Browser end-to-end test for prepaid expenses, deferred revenue and accruals: an owner adds a
 * prepaid expense with its payment posted and deferred revenue with its receipt, posts three
 * months of releases, ends the deferred revenue early with a refund, and posts and cancels a
 * month-end accrual. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));
const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

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

test('an owner releases prepaid expenses and deferred revenue, and accrues at month end', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Deferral Owner');
  await page.getByLabel('Email').fill(`e2e-deferrals-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Deferrals Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const M = T.slice(0, 7);
  const m2 = shift(M, -2);
  const m1 = shift(M, -1);
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const fy of new Set([fyOf(m2), fyOf(shift(M, 1))])) if (!years.has(fy)) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fy })).status, 201);

  await page.getByRole('link', { name: 'Prepaid and deferred', exact: true }).click();
  await page.getByRole('heading', { name: 'Prepaid and deferred', exact: true }).waitFor();
  await page.getByText('No schedules yet').waitFor();
  await page.getByRole('link', { name: 'Add prepaid expense' }).first().click();
  await page.getByRole('heading', { name: 'Add a prepaid expense' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Office insurance');
  await page.getByLabel('Supplier').fill('Shield General Insurance');
  await page.getByLabel('Expense account', { exact: true }).selectOption({ label: '6600 Professional Fees' });
  await page.getByLabel('Amount', { exact: true }).fill('60000');
  await page.getByLabel('Covers from').fill(`${m2}-01`);
  await page.getByLabel('For (months)').fill('12');
  await page.getByLabel('Paid from', { exact: true }).selectOption({ label: '1120 Operating Bank Account' });
  await page.getByLabel('Paid on', { exact: true }).fill(`${m2}-01`);
  await page.getByRole('button', { name: 'Add prepaid expense' }).click();
  await page.getByRole('heading', { name: 'PP-0001 Office insurance' }).waitFor();
  const sched = page.getByRole('table', { name: 'Release schedule' });
  await sched.getByRole('row').nth(1).getByText('₹5,000.00').first().waitFor();
  await page.getByText(/Journal #\d+/).first().waitFor();

  await page.getByRole('link', { name: 'Prepaid and deferred', exact: true }).click();
  await page.getByRole('link', { name: 'Add deferred revenue' }).click();
  await page.getByRole('heading', { name: 'Add deferred revenue' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Annual support contract');
  await page.getByLabel('Customer').fill('Asha Traders');
  await page.getByLabel('Deferred revenue account', { exact: true }).selectOption({ label: '2350 Deferred Revenue' });
  await page.getByLabel('Revenue account', { exact: true }).selectOption({ label: '4200 Service Revenue' });
  await page.getByLabel('Amount', { exact: true }).fill('24000');
  await page.getByLabel('Covers from').fill(`${m1}-01`);
  await page.getByLabel('Received into', { exact: true }).selectOption({ label: '1120 Operating Bank Account' });
  await page.getByLabel('Received on', { exact: true }).fill(`${m1}-01`);
  await page.getByRole('button', { name: 'Add deferred revenue' }).click();
  await page.getByRole('heading', { name: 'DR-0001 Annual support contract' }).waitFor();
  const support = page.url().split('/').pop();

  await page.getByRole('link', { name: 'Prepaid and deferred', exact: true }).click();
  await page.getByRole('table', { name: 'Prepaid and deferred revenue schedules' }).getByText('DR-0001 Annual support contract').waitFor();
  await page.getByRole('link', { name: 'Releases', exact: true }).click();
  const post = page.getByLabel('Post releases');
  await post.getByText(`Releases for ${label(m2)}`, { exact: true }).waitFor();
  await post.getByRole('button', { name: `Post releases for ${label(m2)}` }).click();
  await post.getByText(`Releases for ${label(m1)}`, { exact: true }).waitFor();
  await post.getByRole('table', { name: 'Releases to post' }).getByText('DR-0001 Annual support contract').waitFor();
  await post.getByText('₹7,000.00').first().waitFor();
  await post.getByRole('button', { name: `Post releases for ${label(m1)}` }).click();
  const runs = page.getByRole('table', { name: 'Release runs' });
  await runs.getByRole('row', { name: new RegExp(`${label(m1)}.*Posted`) }).waitFor();
  await runs.getByRole('row', { name: new RegExp(label(m1)) }).getByRole('button', { name: 'Reverse' }).click();
  await runs.getByRole('row', { name: new RegExp(label(m1)) }).getByText(/Reversed by Deferral Owner/).waitFor();
  await post.getByRole('button', { name: `Post releases for ${label(m1)}` }).click();
  await post.getByText(`Releases for ${label(M)}`, { exact: true }).waitFor();
  await post.getByRole('button', { name: `Post releases for ${label(M)}` }).click();
  await runs.getByRole('row', { name: new RegExp(`${label(M)}.*Posted`) }).waitFor();

  await page.goto(`${WEB}/orgs/${orgId}/deferrals/${support}`);
  await page.getByRole('heading', { name: 'DR-0001 Annual support contract' }).waitFor();
  const end = page.getByLabel('End this schedule early');
  await end.getByRole('button', { name: 'End early…' }).click();
  await end.getByLabel('What is left goes to').selectOption({ label: '1120 Operating Bank Account' });
  await end.getByLabel('Note (optional)').fill('Contract cancelled; balance refunded');
  await end.getByText(/₹20,000.00 is left/).waitFor();
  await end.getByRole('button', { name: 'End DR-0001' }).click();
  await page.getByLabel('Ended early').getByText(/₹20,000.00 released in one go/).waitFor();

  await page.getByRole('link', { name: 'Accruals', exact: true }).click();
  await page.getByRole('heading', { name: 'Accruals', exact: true }).waitFor();
  const form = page.getByLabel('Post an accrual');
  await form.getByLabel('What for').fill('Electricity, bill not yet received');
  await form.getByLabel('Supplier').fill('State Power Co');
  await form.getByLabel('Month').fill(m1);
  await form.getByLabel('Expense account', { exact: true }).selectOption({ label: '6300 Utilities' });
  await form.getByLabel('Accrued liability account').selectOption({ label: '2200 Accrued Liabilities' });
  await form.getByLabel('Amount', { exact: true }).fill('8500');
  await form.getByRole('button', { name: 'Post accrual' }).click();
  const table = page.getByRole('table', { name: 'Accruals' });
  await table.getByRole('row', { name: /AC-0001 Electricity/ }).getByText('Posted', { exact: true }).waitFor();
  await table.getByRole('row', { name: /AC-0001 Electricity/ }).getByRole('button', { name: 'Cancel…' }).click();
  await page.getByLabel('Why').fill('Bill arrived and was posted in the month');
  await page.getByRole('button', { name: 'Cancel AC-0001' }).click();
  await table.getByText('Cancelled by Deferral Owner').waitFor();

  const list = (await call(`${base}/deferrals`)).body;
  assert.deepEqual(list.schedules.map((s) => [s.reference, s.status, s.released]), [
    ['PP-0001', 'ACTIVE', '15000.00'],
    ['DR-0001', 'ENDED', '24000.00'],
  ]);
  const acc = (await call(`${base}/deferrals/accruals`)).body;
  assert.equal(acc.accruals[0].status, 'CANCELLED');
  assert.deepEqual(consoleErrors, []);
});
