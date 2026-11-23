/**
 * Browser end-to-end test for arranging a dashboard by drag and drop (RPT-026): an owner with
 * posted invoices drags metrics from the palette into the layout (a new figure and a metric
 * onto a chart), drags a widget to a new place, sees a drop that would mix units refused, uses
 * the keyboard alternative (pick a metric, Add here, Move earlier) and finds the layout saved
 * after a reload. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));
const L = shift(T.slice(0, 7), -1);
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
const titles = async () => (await page.getByRole('list', { name: 'Widgets in order' }).locator('li[data-testid^="w-"] p.font-medium').allTextContents());

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner arranges a dashboard by dragging metrics and widgets, or with the keyboard', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Arun Arranger');
  await page.getByLabel('Email').fill(`e2e-arrange-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Arrange Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set(ok(await call(`${base}/periods`), 'periods').map((p) => p.fiscalYear));
  if (!years.has(fyOf(L))) ok(await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(L) }), 'fiscal year');
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const acme = ok(await call(`${base}/contacts`, { name: 'Acme Retail', isCustomer: true }), 'customer').id;
  ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: acme, issueDate: `${L}-10`, dueDate: `${L}-10`, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '250000.00' }] }), 'invoice');
  const d = ok(
    await call(`${base}/dashboards`, {
      name: 'Board view',
      config: {
        widgets: [
          { type: 'STAT', title: 'Revenue', metric: 'revenue', compare: 'NONE' },
          { type: 'BAR', title: 'Profit', metrics: ['grossProfit'], months: 3 },
        ],
      },
    }),
    'dashboard',
  );
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/reports/dashboards/${d.id}`);
  await page.getByRole('region', { name: 'Revenue', exact: true }).getByText('₹2,50,000.00').waitFor();
  await page.getByRole('button', { name: 'Arrange' }).click();
  await page.getByText('Metrics to drag', { exact: true }).waitFor();
  const status = page.getByTestId('arrange-status');

  // Drag "Cash and bank" into the first gap: a new figure at the top.
  await page.locator('[data-metric="cash"]').dragTo(page.getByTestId('gap-0'));
  await status.getByText('Added Cash and bank as a figure at position 1. Saved as version 2.').waitFor();
  assert.deepEqual(await titles(), ['Cash and bank', 'Revenue', 'Profit']);
  await page.getByTestId('dashboard').getByRole('region', { name: 'Cash and bank', exact: true }).waitFor();

  // Drag "Net income" onto the Profit bar chart: it joins the chart.
  await page.locator('[data-metric="netIncome"]').dragTo(page.getByTestId('w-2'));
  await status.getByText('Added Net income to Profit. Saved as version 3.').waitFor();
  await page.getByTestId('w-2').getByText('Bar chart: Gross profit, Net income').waitFor();

  // A percentage cannot join a chart of amounts: refused in words, nothing saved.
  await page.locator('[data-metric="grossMargin"]').dragTo(page.getByTestId('w-2'));
  await status.getByText('Profit shows amounts; Gross margin is measured in percentages, so it needs its own chart').waitFor();
  await page.getByTestId('w-2').getByText('Bar chart: Gross profit, Net income').waitFor();

  // Drag the Profit chart to the top.
  await page.getByTestId('w-2').dragTo(page.getByTestId('gap-0'));
  await status.getByText('Moved Profit to position 1. Saved as version 4.').waitFor();
  assert.deepEqual(await titles(), ['Profit', 'Cash and bank', 'Revenue']);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-arrange.png`, fullPage: true });

  // Keyboard alternative: pick a metric with its button, then "Add here"; then Move earlier.
  await page.locator('[data-metric="receivables"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-metric="receivables"]').getAttribute('aria-pressed'), 'true');
  await page.getByTestId('gap-3').getByRole('button', { name: 'Add Receivables here' }).click();
  await status.getByText('Added Receivables as a figure at position 4. Saved as version 5.').waitFor();
  const added = 'Receivables';
  assert.equal((await titles())[3], added);
  await page.getByRole('button', { name: `Move ${added} earlier` }).click();
  await status.getByText(`Moved ${added} to position 3. Saved as version 6.`).waitFor();
  await page.getByRole('button', { name: 'Remove Revenue' }).click();
  await status.getByText('Removed Revenue. Saved as version 7.').waitFor();
  assert.deepEqual(await titles(), ['Profit', 'Cash and bank', added]);

  // The layout is saved for everyone: reload and it is still there.
  await page.getByRole('button', { name: 'Done arranging' }).click();
  await page.reload();
  const view = page.getByTestId('dashboard');
  await view.getByRole('region', { name: 'Profit', exact: true }).waitFor();
  const order = await view.locator(':scope > section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  assert.deepEqual(order, ['Profit', 'Cash and bank', added]);
  assert.deepEqual(consoleErrors.filter((e) => !/422/.test(e)), []);
});
