/**
 * Browser end-to-end test for role dashboards (DASH-044/045/053/063/064/066/067/068): an owner
 * opens Reports → Role dashboards, reads the CEO's headline and largest customers, switches to
 * the CFO, treasury, risk officer, compliance and board dashboards (each with its own sections),
 * finds the board view names no customer, and the chosen role survives a reload. Real Next.js
 * app → real API → real MongoDB.
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
const [ty, tm] = T.split('-').map(Number);
const P = tm === 1 ? `${ty - 1}-12-15` : `${ty}-${String(tm - 1).padStart(2, '0')}-15`;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner reads a dashboard for each role, each laid out for that role', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Roles');
  await page.getByLabel('Email').fill(`e2e-roles-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Role Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const periods = ok(await call(`${base}/periods`), 'periods');
  if (!periods.some((p) => p.startDate <= P)) await call(`${base}/periods/fiscal-years`, { fiscalYear: Number(periods[0].startDate.slice(0, 4)) - 1 });
  const id = {};
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods']) id[name] = ok(await call(`${base}/contacts`, { name, isCustomer: true }), name).id;
  for (const name of ['Granite Supplies', 'Harbour Freight']) id[name] = ok(await call(`${base}/contacts`, { name, isVendor: true }), name).id;
  for (const [who, amount] of [['Asha Traders', '600000.00'], ['Banyan Retail', '250000.00'], ['Cedar Foods', '150000.00']]) ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: id[who], issueDate: P, dueDate: d(10), post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] }), who);
  for (const [who, amount, ref] of [['Granite Supplies', '70000.00', 'G-1'], ['Harbour Freight', '30000.00', 'H-1']]) ok(await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: id[who], issueDate: P, dueDate: d(15), reference: ref, post: true, lines: [{ accountId: acc['6100'], quantity: '1', unitPrice: amount }] }), who);
  ok(await call(`${base}/journals`, { date: P, memo: 'Capital', post: true, lines: [{ accountId: acc['1120'], debit: '500000.00' }, { accountId: acc['3100'], credit: '500000.00' }] }), 'capital');
  ok(await call(`${base}/journals`, { date: P, memo: 'Petty cash', post: true, lines: [{ accountId: acc['1110'], debit: '20000.00' }, { accountId: acc['1120'], credit: '20000.00' }] }), 'petty');
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/reports/role-dashboards`);
  await page.getByRole('heading', { name: 'Role dashboards', exact: true }).waitFor();
  const tabs = page.getByRole('tablist', { name: 'Dashboard for' });
  const shot = async (name) => SHOTS && (await page.screenshot({ path: `${SHOTS}/role-dashboards-${name}.png`, fullPage: true }));

  // CEO (the default): headline revenue, largest customers.
  assert.equal(await tabs.getByRole('tab', { name: 'CEO', exact: true }).getAttribute('aria-selected'), 'true');
  const headline = page.getByRole('region', { name: 'The headline' });
  await headline.getByRole('group', { name: 'Revenue' }).getByText('₹10,00,000.00', { exact: true }).waitFor();
  await page.getByRole('region', { name: 'Largest customers' }).getByText('Asha Traders').waitFor();
  await page.getByRole('region', { name: 'Largest customers' }).getByText(/60\.0%/).first().waitFor();
  await page.getByRole('table', { name: 'Revenue by month figures' }).waitFor();
  await page.getByRole('img', { name: /Revenue by month as bars/ }).waitFor();
  await shot('ceo');

  // CFO: margins and what is owed both ways.
  await tabs.getByRole('tab', { name: 'CFO', exact: true }).click();
  await page.waitForURL(/role=CFO/);
  const owed = page.getByRole('region', { name: 'Owed both ways' });
  await owed.getByText('3 open invoices', { exact: false }).waitFor();
  await owed.getByText('2 open bills', { exact: false }).waitFor();
  await page.getByRole('table', { name: 'Margins by month' }).getByRole('row', { name: /Gross margin/ }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'The headline' }).count(), 0);
  await shot('cfo');

  // Treasury: cash by account, the next 90 days, money coming in.
  await tabs.getByRole('tab', { name: 'Treasury', exact: true }).click();
  await page.waitForURL(/role=TREASURY/);
  await page.getByRole('list', { name: 'Cash and bank accounts' }).getByText('1120 · Operating Bank Account').waitFor();
  await page.getByRole('table', { name: 'Cash by week' }).waitFor();
  const coming = page.getByRole('table', { name: 'Invoices expected to be paid' });
  await coming.getByRole('row', { name: /Asha Traders/ }).waitFor();
  await page.getByRole('table', { name: 'Bills in payment order' }).getByRole('row', { name: /Granite Supplies/ }).waitFor();
  await shot('treasury');

  // Risk officer: areas and single dependencies.
  await tabs.getByRole('tab', { name: 'Risk officer', exact: true }).click();
  await page.waitForURL(/role=RISK/);
  await page.getByRole('region', { name: 'Single dependencies' }).getByText('60% of revenue comes from Asha Traders').waitFor();
  assert.equal(await page.getByRole('list', { name: 'Areas by score' }).getByRole('listitem').count(), 6);
  await page.getByRole('table', { name: 'Concentration of each group' }).getByRole('row', { name: /Customers \(revenue\)/ }).waitFor();
  await shot('risk');

  // Compliance: deadlines and tax.
  await tabs.getByRole('tab', { name: 'Compliance', exact: true }).click();
  await page.waitForURL(/role=COMPLIANCE/);
  await page.getByRole('region', { name: 'Deadlines at a glance' }).getByRole('group', { name: 'Next deadline' }).waitFor();
  await page.getByRole('region', { name: 'Tax due in the next 3 months' }).waitFor();
  await shot('compliance');

  // Board: quarters and position, no names.
  await tabs.getByRole('tab', { name: 'Board and investors', exact: true }).click();
  await page.waitForURL(/role=BOARD/);
  await page.getByRole('table', { name: 'Results by quarter figures' }).waitFor();
  const conc = page.getByRole('region', { name: 'Customer concentration' });
  await conc.getByText('Highly concentrated').waitFor();
  await conc.getByText(/60\.0% of revenue/).waitFor();
  const panel = page.getByRole('tabpanel');
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods', 'Granite Supplies']) assert.equal(await panel.getByText(name).count(), 0, `${name} shown to the board`);
  await shot('board');

  // The role stays in the address.
  await page.reload();
  await page.getByRole('region', { name: 'Results by quarter' }).waitFor();
  assert.equal(await tabs.getByRole('tab', { name: 'Board and investors', exact: true }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(consoleErrors, []);
});
