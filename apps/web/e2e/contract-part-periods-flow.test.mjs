/**
 * Browser end-to-end test for part periods on contracts: an owner sets up a monthly contract that
 * started mid-month two months ago and is billed on the 1st, sees the part periods in what is
 * coming up, activates it, and finds the first invoice charged for its share of days.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const month = (n) => {
  const [y, m] = T.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};
const START = `${month(-2)}-15`;
const END = `${month(2)}-10`;
const daysInMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
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

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a contract billed on the 1st charges its part periods by days', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Part Period Owner');
  await page.getByLabel('Email').fill(`e2e-part-periods-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Part Periods Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const orgId = base.split('/orgs/')[1];
  await call(`/v1/orgs/${orgId}/contacts`, { name: 'Iyer Clinics', isCustomer: true });

  await page.goto(`${base}/sales/contracts/new`);
  await page.getByRole('heading', { name: 'New contract' }).waitFor();
  await page.getByLabel('Customer', { exact: true }).locator('option', { hasText: 'Iyer Clinics' }).waitFor({ state: 'attached' });
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Iyer Clinics' });
  await page.getByLabel('Title').fill('Payroll processing');
  await page.getByLabel('Start date').fill(START);
  await page.getByLabel('End date', { exact: true }).fill(END);
  await page.getByLabel('Bill on day of month').fill('1');
  await page.getByLabel('Account for line 1').selectOption({ label: '4100 · Sales Revenue' });
  await page.getByLabel('Description for line 1').fill('Payroll');
  await page.getByLabel('Unit price for line 1').fill('30000');
  await page.getByRole('button', { name: 'Save draft contract' }).click();
  await page.getByRole('heading', { name: 'CT-0001 Payroll processing' }).waitFor();
  const upcoming = page.getByRole('table', { name: 'Upcoming periods' });
  const firstDays = daysInMonth(month(-2)) - 14;
  await upcoming.getByText(`${firstDays} of ${daysInMonth(month(-2))} days`).waitFor();
  await upcoming.getByText(`10 of ${daysInMonth(month(2))} days`).waitFor();
  assert.equal(await upcoming.getByText('Full period').count(), 3);
  await page.getByText('Day 1 of the month; part periods are billed by days').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/contract-part-periods.png`, fullPage: true });

  await page.getByRole('button', { name: 'Activate' }).click();
  const billed = page.getByRole('table', { name: 'Billed periods' });
  await billed.getByRole('row').nth(3).waitFor();
  await billed.getByRole('link', { name: 'Draft invoice' }).last().click();
  await page.getByRole('heading', { name: 'Draft invoice' }).waitFor();
  await page.getByText(`Payroll (part period: ${firstDays} of ${daysInMonth(month(-2))} days)`).first().waitFor();
  const expected = ((30000 * firstDays) / daysInMonth(month(-2))).toFixed(2);
  const contracts = (await call(`/v1/orgs/${orgId}/sales/contracts`)).body.contracts;
  const c = (await call(`/v1/orgs/${orgId}/sales/contracts/${contracts[0].id}`)).body;
  const first = (await call(`/v1/orgs/${orgId}/sales/documents/${c.periods.at(-1).invoice.id}`)).body;
  assert.equal(first.subtotal, expected);
  assert.equal(first.issueDate, START);
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
