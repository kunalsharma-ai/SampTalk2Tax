/**
 * Browser end-to-end test for the accountant, controller, internal audit and procurement
 * dashboards (DASH-047/048/054/056): an owner with a draft journal, an issued purchase order that
 * is late, a control and an audit finding opens the accountant's dashboard, opens the draft
 * journal from it, then reads the controller, internal audit and procurement dashboards. Real
 * Next.js app → real API → real MongoDB.
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
const weekday = (k) => (new Date(`${d(k)}T00:00:00Z`).getUTCDay() === 0 ? d(k - 1) : d(k));

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner reads the accountant, controller, internal audit and procurement dashboards', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Books');
  await page.getByLabel('Email').fill(`e2e-books-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Books Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const meId = ok(await call('/v1/auth/me'), 'me').user.id;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const periods = ok(await call(`${base}/periods`), 'periods');
  if (!periods.some((p) => p.startDate <= d(-10))) await call(`${base}/periods/fiscal-years`, { fiscalYear: Number(periods[0].startDate.slice(0, 4)) - 1 });
  const vendor = ok(await call(`${base}/contacts`, { name: 'Granite Supplies', isVendor: true }), 'vendor').id;
  const journal = ok(await call(`${base}/journals`, { date: d(-1), memo: 'Accrue November rent', lines: [{ accountId: acc['6100'], debit: '25000.00' }, { accountId: acc['3100'], credit: '25000.00' }] }), 'journal');
  const po = ok(await call(`${base}/purchases/orders`, { contactId: vendor, orderDate: d(-10), expectedDate: d(-2), lines: [{ accountId: acc['6600'], description: 'Packing cartons', quantity: '100', unitPrice: '40' }] }), 'po');
  ok(await call(`${base}/purchases/orders/${po.id}/issue`, {}), 'issue');
  ok(await call(`${base}/controls`, { templateId: 'BANK_RECONCILIATION', ownerId: meId }), 'control');
  ok(await call(`${base}/audit-findings`, { title: 'Payments approved after release', description: 'Two payments were approved after the bank sent them.', severity: 'HIGH', ownerId: meId, plan: 'Approve payment batches before release' }), 'finding');
  consoleErrors = [];
  const shot = async (name) => SHOTS && (await page.screenshot({ path: `${SHOTS}/role-dashboards-${name}.png`, fullPage: true }));

  // Accountant: the work waiting and the draft journal.
  await page.goto(`${WEB}/orgs/${orgId}/reports/role-dashboards?role=ACCOUNTANT`);
  const tabs = page.getByRole('tablist', { name: 'Dashboard for' });
  await page.getByRole('group', { name: 'Draft journals' }).getByText('1', { exact: true }).waitFor();
  await page.getByRole('region', { name: 'Recent closes' }).getByText('this month').first().waitFor();
  await shot('accountant');

  // Controller: closes, separation of duties, controls.
  await tabs.getByRole('tab', { name: 'Controller', exact: true }).click();
  await page.waitForURL(/role=CONTROLLER/);
  await page.getByRole('group', { name: 'Open audit findings' }).getByText('1', { exact: true }).waitFor();
  await page.getByRole('table', { name: 'Duty conflicts by rule' }).waitFor();
  await page.getByRole('table', { name: 'Closes for the controller' }).waitFor();
  await shot('controller');

  // Internal audit: the finding.
  await tabs.getByRole('tab', { name: 'Internal audit', exact: true }).click();
  await page.waitForURL(/role=INTERNAL_AUDITOR/);
  await page.getByRole('table', { name: 'Open audit findings' }).getByRole('row', { name: /F-001 · Payments approved after release high open/ }).waitFor();
  await page.getByRole('region', { name: 'Audits in progress' }).getByText('No audit is in progress.').waitFor();
  await shot('internal-audit');

  // Procurement: the late order.
  await tabs.getByRole('tab', { name: 'Procurement', exact: true }).click();
  await page.waitForURL(/role=PROCUREMENT/);
  await page.getByRole('list', { name: 'Orders delivered late' }).getByText('Granite Supplies', { exact: false }).waitFor();
  await page.getByRole('table', { name: 'Open orders' }).getByRole('row', { name: /Granite Supplies.*\(late\)/ }).waitFor();
  await shot('procurement');

  // Back to the accountant, and open the draft journal.
  await tabs.getByRole('tab', { name: 'Accountant', exact: true }).click();
  await page.getByRole('list', { name: 'Draft journals' }).getByRole('link', { name: 'Accrue November rent' }).click();
  await page.waitForURL(new RegExp(`/journals/${journal.id}$`));
  assert.deepEqual(consoleErrors, []);
});
