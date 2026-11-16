/**
 * Browser end-to-end test for dashboards: an owner with posted invoices builds a dashboard from
 * approved metrics, previews it, saves it, views another month, changes it and deletes it.
 * Real Next.js app → real API → real PostgreSQL.
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
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));
const L = shift(T.slice(0, 7), -1);
const P = shift(L, -1);
const label = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
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

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => browser?.close());

test('an owner builds a dashboard from approved metrics, previews, saves, changes and deletes it', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dina Dashboards');
  await page.getByLabel('Email').fill(`e2e-dash-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Dashboard Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set(ok(await call(`${base}/periods`), 'periods').map((p) => p.fiscalYear));
  for (const m of [P, L]) if (!years.has(fyOf(m))) ok(await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(m) }), 'fiscal year'), years.add(fyOf(m));
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const acme = ok(await call(`${base}/contacts`, { name: 'Acme Retail', isCustomer: true }), 'customer').id;
  for (const [d, amt] of [[`${P}-10`, '100000.00'], [`${L}-10`, '250000.00']]) ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: acme, issueDate: d, dueDate: d, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amt }] }), 'invoice');

  await page.goto(`${WEB}/orgs/${orgId}/reports/dashboards`);
  await page.getByText('No dashboards yet').waitFor();
  await page.getByRole('link', { name: 'New dashboard' }).click();
  await page.getByRole('region', { name: 'Describe the dashboard' }).waitFor();
  await page.getByLabel('Dashboard name').fill('Sales at a glance');
  await page.getByRole('button', { name: 'Add figure' }).click();
  await page.getByLabel('Widget 1 title').fill('Revenue');
  await page.getByRole('button', { name: 'Add line chart' }).click();
  await page.getByLabel('Widget 2 title').fill('Revenue and gross profit');
  const metrics = page.getByRole('group', { name: 'Widget 2 metrics' });
  await metrics.getByLabel('Gross profit').check();
  // A chart only shows metrics measured the same way.
  assert.equal(await metrics.getByLabel('Gross margin').isDisabled(), true);
  await page.getByLabel('Widget 2 months').selectOption('3');
  await page.getByRole('button', { name: 'Add top customers' }).click();
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('region', { name: 'Preview' });
  await preview.getByRole('region', { name: 'Revenue', exact: true }).getByText('₹2,50,000.00').waitFor();
  await preview.getByText('+₹1,50,000.00').waitFor();
  await preview.getByRole('table', { name: 'Largest customers' }).getByText('Acme Retail').waitFor();
  await page.getByRole('button', { name: 'Save dashboard' }).click();
  await page.waitForURL(/\/reports\/dashboards\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'DB-0001 · Sales at a glance' }).waitFor();
  await page.getByTestId('dashboard').getByText('₹2,50,000.00').first().waitFor();

  // The month before.
  await page.getByLabel('Month', { exact: true }).selectOption(P);
  await page.getByText(`Figures for ${label(P)}`).waitFor();
  await page.getByRole('region', { name: 'Revenue', exact: true }).getByText('₹1,00,000.00', { exact: true }).waitFor();

  // Change it: drop the customers, move the chart first.
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Widget 3 title').waitFor();
  await page.getByRole('group', { name: 'Widget 3' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('group', { name: 'Widget 2' }).getByRole('button', { name: 'Up' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/\/reports\/dashboards\/[0-9a-f-]{36}$/);
  await page.getByRole('region', { name: 'Revenue and gross profit' }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Largest customers' }).count(), 0);
  const saved = ok(await call(`${base}/dashboards`), 'list').items[0];
  assert.deepEqual(saved.config.widgets.map((w) => w.type), ['LINE', 'STAT']);

  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByText('No dashboards yet').waitFor();
  assert.deepEqual(consoleErrors, []);
});
