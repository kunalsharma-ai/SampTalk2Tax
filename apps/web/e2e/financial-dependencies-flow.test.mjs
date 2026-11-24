/**
 * Browser end-to-end test for financial dependencies (DASH-037): an owner whose revenue leans on
 * one customer opens Reports → Financial dependencies, sees the dependencies to watch, chooses a
 * customer in the network with the keyboard and by mouse to see its share, hides a group, and
 * opens the customer. Real Next.js app → real API → real MongoDB.
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

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner finds the customer the business leans on and opens it', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Dependencies');
  await page.getByLabel('Email').fill(`e2e-deps-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Dependency Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const periods = ok(await call(`${base}/periods`), 'periods');
  if (!periods.some((p) => p.startDate <= d(-40))) await call(`${base}/periods/fiscal-years`, { fiscalYear: Number(periods[0].startDate.slice(0, 4)) - 1 });
  const id = {};
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods']) id[name] = ok(await call(`${base}/contacts`, { name, isCustomer: true }), name).id;
  for (const name of ['Granite Supplies', 'Harbour Freight']) id[name] = ok(await call(`${base}/contacts`, { name, isVendor: true }), name).id;
  for (const [who, amount] of [['Asha Traders', '600000.00'], ['Banyan Retail', '250000.00'], ['Cedar Foods', '150000.00']]) ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: id[who], issueDate: d(-20), dueDate: d(10), post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] }), who);
  for (const [who, amount, ref] of [['Granite Supplies', '70000.00', 'G-1'], ['Harbour Freight', '30000.00', 'H-1']]) ok(await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: id[who], issueDate: d(-15), dueDate: d(15), reference: ref, post: true, lines: [{ accountId: acc['6100'], quantity: '1', unitPrice: amount }] }), who);
  ok(await call(`${base}/journals`, { date: d(-30), memo: 'Capital', post: true, lines: [{ accountId: acc['1120'], debit: '500000.00' }, { accountId: acc['3100'], credit: '500000.00' }] }), 'capital');
  ok(await call(`${base}/journals`, { date: d(-29), memo: 'Petty cash', post: true, lines: [{ accountId: acc['1110'], debit: '20000.00' }, { accountId: acc['1120'], credit: '20000.00' }] }), 'petty');
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/reports/dependencies`);
  await page.getByRole('heading', { name: 'Financial dependencies', exact: true }).waitFor();
  const watch = page.getByRole('region', { name: 'Dependencies to watch' });
  await watch.getByRole('button', { name: '60% of revenue comes from Asha Traders' }).waitFor();
  await watch.getByText('70% of spending goes to Granite Supplies').waitFor();
  await watch.getByText('96% of cash sits in 1120 · Operating Bank Account').waitFor();
  const customers = page.getByRole('table', { name: 'Customers by share' });
  await customers.getByRole('row', { name: /Banyan Retail.*25%/ }).waitFor();
  await page.getByRole('region', { name: 'Customers', exact: true }).getByText('Highly concentrated').waitFor();

  // Keyboard: focus Asha in the network and press Enter.
  const network = page.getByRole('img', { name: /A network of who the business depends on/ });
  const asha = network.getByRole('button', { name: /Revenue from Asha Traders: .*60%, critical dependency/ });
  await asha.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Chosen party' });
  await panel.getByRole('heading', { name: 'Asha Traders' }).waitFor();
  await panel.getByText('60% of revenue comes from Asha Traders').waitFor();
  await panel.getByRole('link', { name: 'Explore connections' }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/financial-dependencies.png`, fullPage: true });

  // Mouse: a vendor; then hide vendors.
  await network.getByRole('button', { name: /Spending with Harbour Freight/ }).click();
  await panel.getByRole('heading', { name: 'Harbour Freight' }).waitFor();
  await page.getByRole('checkbox', { name: 'Vendors' }).uncheck();
  assert.equal(await network.getByRole('button', { name: /Spending with/ }).count(), 0);
  await panel.getByText('Choose a customer, vendor, account or lender').waitFor();

  await customers.getByRole('button', { name: 'Asha Traders' }).click();
  await panel.getByRole('link', { name: 'Open customer' }).click();
  await page.waitForURL(new RegExp(`/sales/customers/${id['Asha Traders']}$`));
  assert.deepEqual(consoleErrors, []);
});
