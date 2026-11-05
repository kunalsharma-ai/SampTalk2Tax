/**
 * Browser end-to-end test for disaster simulation: an owner with a large customer and a key
 * supplier runs the standard stress tests, opens "largest customer defaults", runs and saves it,
 * adds a cash freeze, sees each shock on its own, turns the simulation into a digital-twin
 * scenario and deletes the simulation.
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
const LAST = shift(T.slice(0, 7), -1);
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
after(async () => {
  await browser?.close();
});

test('an owner stress-tests the business, saves a customer default, adds a cash freeze and opens it as a twin scenario', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dara Disaster');
  await page.getByLabel('Email').fill(`e2e-disaster-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Disaster Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!years.has(fyOf(LAST))) ok(await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(LAST) }), 'fiscal year');
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const acme = ok(await call(`${base}/contacts`, { name: 'Acme Retail', isCustomer: true }), 'acme').id;
  const beta = ok(await call(`${base}/contacts`, { name: 'Beta Stores', isCustomer: true }), 'beta').id;
  const granite = ok(await call(`${base}/contacts`, { name: 'Granite Parts', isVendor: true }), 'granite').id;
  for (const [c, amount] of [[acme, '300000.00'], [beta, '100000.00']]) ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: c, issueDate: `${LAST}-01`, dueDate: `${LAST}-28`, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] }), 'invoice');
  ok(await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: granite, issueDate: `${LAST}-05`, reference: 'GP-1', post: true, lines: [{ accountId: acc['5000'], quantity: '1', unitPrice: '120000.00' }] }), 'bill');
  ok(await call(`${base}/journals`, { date: `${LAST}-15`, memo: 'Capital', post: true, lines: [{ accountId: acc['1120'], debit: '1000000.00' }, { accountId: acc['3100'], credit: '1000000.00' }] }), 'capital');

  await page.getByRole('link', { name: 'Disaster simulation' }).click();
  await page.getByRole('heading', { name: 'Disaster simulation' }).waitFor();
  const summary = page.getByTestId('stress-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /^The business gets through \d of 7 standard shocks/);
  const tests = page.getByRole('table', { name: 'Stress tests' });
  assert.equal(await tests.getByRole('row').count(), 8);
  await page.getByText('No saved simulations yet').waitFor();

  // Open the customer default and run it.
  await tests.getByRole('row', { name: /Largest customer defaults \(Acme Retail\)/ }).getByRole('link', { name: 'Open' }).click();
  await page.getByRole('heading', { name: 'Largest customer defaults (Acme Retail)' }).waitFor();
  const shock1 = page.getByRole('group', { name: 'Shock 1: Customer default' });
  await shock1.waitFor();
  assert.equal(await shock1.getByLabel('Customer').inputValue(), acme);
  await page.getByRole('button', { name: 'Run the simulation' }).click();
  await page.getByTestId('disaster-summary').waitFor();
  assert.match(await page.getByTestId('disaster-summary').innerText(), /^With this shock, /);
  const each = page.getByRole('table', { name: 'Each shock on its own' });
  assert.match(await each.innerText(), /Acme Retail defaults/);
  assert.match(await each.innerText(), /300000\.00 Acme Retail owes is never paid/);

  // Save it, then add a cash freeze.
  await page.getByLabel('Name').fill('Acme goes under');
  await page.getByRole('button', { name: 'Save simulation' }).click();
  await page.waitForURL(/\/planning\/disasters\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Acme goes under' }).waitFor();
  await page.getByTestId('disaster-summary').waitFor();
  await page.getByRole('button', { name: 'Liquidity shock' }).click();
  const shock2 = page.getByRole('group', { name: 'Shock 2: Liquidity shock' });
  await shock2.getByLabel('Cash frozen').fill('500000');
  await shock2.getByLabel('Extra days customers take to pay').fill('0');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Saved.').waitFor();
  await each.getByRole('row').nth(2).waitFor();
  assert.equal(await each.getByRole('row').count(), 3);
  assert.match(await each.innerText(), /cannot be used from .* and is released in/);
  assert.equal(await page.getByRole('table', { name: 'Month by month' }).getByRole('row').count(), 13);

  // A bad figure is explained.
  await shock2.getByLabel('Months the cash stays frozen').fill('0');
  await page.getByRole('button', { name: 'Run the simulation' }).click();
  await page.getByText('Shock 2: Months the cash stays frozen must be a whole number from 1 to 60').waitFor();
  await shock2.getByLabel('Months the cash stays frozen').fill('3');

  // Into the digital twin.
  await page.getByRole('button', { name: 'Open as a twin scenario' }).click();
  await page.waitForURL(/\/planning\/twin\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Acme goes under (DS-0001)' }).waitFor();

  // Back to the list, then delete.
  await page.goto(`${WEB}/orgs/${orgId}/planning/disasters`);
  const saved = page.getByRole('table', { name: 'Saved simulations' });
  await saved.waitFor();
  assert.match(await saved.innerText(), /Acme goes under\s+DS-0001/);
  await saved.getByRole('link', { name: 'Acme goes under' }).click();
  await page.getByRole('heading', { name: 'Acme goes under' }).waitFor();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL(/\/planning\/disasters$/);
  await page.getByText('No saved simulations yet').waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|status of 422/.test(e)), []);
});
