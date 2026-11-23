/**
 * Browser end-to-end test for the financial timeline (DASH-033): an owner with journals over the
 * last weeks and a GST registration opens Reports → Financial timeline, reads cash in, cash out
 * and the balance, switches to days, chooses a day to see its entries, hides a kind of entry,
 * sees the deadlines, and opens an entry's journal. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const ok = (r, what) => {
  assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const d = (k) => new Date(Date.parse(`${T}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const label = (k) => new Date(`${d(k)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner reads the financial timeline, narrows it to a day and opens an entry', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Timeline');
  await page.getByLabel('Email').fill(`e2e-timeline-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Timeline Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const periods = ok(await call(`${base}/periods`), 'periods');
  if (!periods.some((p) => p.startDate <= d(-40))) await call(`${base}/periods/fiscal-years`, { fiscalYear: Number(periods[0].startDate.slice(0, 4)) - 1 });
  const j = async (date, reference, lines) => ok(await call(`${base}/journals`, { date, memo: reference, reference, post: true, lines }), reference);
  await j(d(-40), 'CAPITAL', [{ accountId: acc['1120'], debit: '200000.00' }, { accountId: acc['3100'], credit: '200000.00' }]);
  const sale = await j(d(-6), 'SALE-77', [{ accountId: acc['1120'], debit: '45000.00' }, { accountId: acc['4100'], credit: '45000.00' }]);
  await j(d(-6), 'RENT-11', [{ accountId: acc['6200'], debit: '18000.00' }, { accountId: acc['1120'], credit: '18000.00' }]);
  await j(d(-2), 'ACCRUE-3', [{ accountId: acc['6100'], debit: '2500.00' }, { accountId: acc['2200'], credit: '2500.00' }]);
  const state = '27';
  const pan = 'ZZZTL0002Z';
  // A valid GSTIN for the calendar: compute the check character as the API does.
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const body = `${state}${pan}1Z`;
  const sum = [...body].reduce((t, ch, i) => { const v = chars.indexOf(ch) * (i % 2 ? 2 : 1); return t + Math.floor(v / 36) + (v % 36); }, 0);
  ok(await call(`${base}/gst/registration`, { gstin: `${body}${chars[(36 - (sum % 36)) % 36]}`, effectiveFrom: `${d(-120).slice(0, 7)}-01` }, 'PUT'), 'gst');
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/reports/timeline`);
  await page.getByRole('heading', { name: 'Financial timeline', exact: true }).waitFor();
  const cash = page.getByRole('region', { name: 'Cash over time' });
  await cash.getByText('₹2,45,000.00').first().waitFor(); // cash in
  await cash.getByText('₹18,000.00').first().waitFor(); // cash out
  await cash.getByText('₹2,27,000.00').first().waitFor(); // cash now
  await page.getByRole('img', { name: /Cash in, cash out and the cash balance over time/ }).locator('.recharts-bar-rectangle').first().waitFor();
  const happened = page.getByRole('region', { name: 'What happened' });
  await happened.getByRole('table', { name: 'Entries in view' }).getByText('SALE-77 · SALE-77').waitFor();
  await happened.getByRole('list', { name: 'Deadlines in view' }).getByText(/GSTR-3B/).first().waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/financial-timeline.png`, fullPage: true });

  // By day, then the day of the sale and the rent.
  await page.getByLabel('Show by').selectOption('DAY');
  const periodsTable = page.getByRole('table', { name: 'Timeline by period' });
  await periodsTable.getByRole('button', { name: label(-6), exact: true }).click();
  const entries = happened.getByRole('table', { name: 'Entries in view' });
  await entries.getByText('RENT-11 · RENT-11').waitFor();
  assert.equal(await entries.locator('tbody tr').count(), 2);
  await happened.getByText(`${label(-6)}. Choose the bar again`).waitFor();
  // Hide manual journals: nothing of the kinds shown on that day.
  await cash.getByRole('checkbox', { name: /Manual journals/ }).uncheck();
  await happened.getByText('No entries of the kinds shown in this part of the timeline.').waitFor();
  await cash.getByRole('checkbox', { name: /Manual journals/ }).check();
  await happened.getByRole('button', { name: 'Show the whole range' }).click();
  await entries.getByText('ACCRUE-3 · ACCRUE-3').waitFor();

  // Open the sale's journal.
  await entries.getByRole('row', { name: /SALE-77/ }).getByRole('link').click();
  await page.waitForURL(new RegExp(`/journals/${sale.id}$`));
  assert.deepEqual(consoleErrors, []);
});
