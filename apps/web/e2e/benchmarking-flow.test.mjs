/**
 * Browser end-to-end test for benchmarking: an owner sees their own metrics from the books, joins
 * the network with consent, sees how they compare once five other participants share the same
 * metric (only the median: fewer than ten), changes what is shared, and withdraws. The peers are
 * five more organisations set up through the API and withdrawn at the end, so the pool is left as
 * it was. Real Next.js app → real API → real PostgreSQL.
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
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const L = shift(T.slice(0, 7), -1);
const join = { industry: 'EDUCATION', sizeBand: 'LARGE', headcount: null, consent: true };
const peers = [];

/** An organisation with revenue of 1,00,000 and the given cost of sales last month. */
async function books(orgId, revenue, cost) {
  const base = `/v1/orgs/${orgId}`;
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!years.has(fyOf(L))) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(L) })).status, 201);
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const j = (dr, cr, amount) => call(`${base}/journals`, { date: `${L}-15`, memo: 'Benchmark e2e', post: true, lines: [{ accountId: acc[dr], debit: amount }, { accountId: acc[cr], credit: amount }] });
  assert.equal((await j('1120', '4100', revenue)).status, 201);
  assert.equal((await j('5000', '1120', cost)).status, 201);
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => {
  for (const id of peers) await call(`/v1/orgs/${id}/benchmarking/participation`, undefined, 'DELETE').catch(() => {});
  await browser?.close();
});

test('an owner joins benchmarking, compares with five peers, changes what is shared and withdraws', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Bea Bench');
  await page.getByLabel('Email').fill(`e2e-bench-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Bench School');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  await books(orgId, '100000.00', '24000.00'); // gross margin 76%

  // Own metrics, before taking part.
  await page.getByRole('link', { name: 'Benchmarking', exact: true }).click();
  await page.waitForURL(/\/benchmarking$/);
  const metrics = page.getByRole('table', { name: 'Metrics' });
  await metrics.getByRole('row', { name: /Gross margin/ }).getByText('76.0%').waitFor();
  assert.equal(await metrics.getByText('Peers’ median').count(), 0);
  await page.getByLabel('Methodology').getByText('Same industry, size band and country').waitFor();

  // Join with consent, sharing everything.
  await page.getByLabel('Industry', { exact: true }).selectOption('EDUCATION');
  await page.getByLabel('Size', { exact: true }).selectOption('LARGE');
  const joinButton = page.getByRole('button', { name: 'Join and compare' });
  assert.equal(await joinButton.isDisabled(), true);
  await page.getByLabel(/I agree, on behalf of E2E Bench School/).check();
  await joinButton.click();
  await page.getByRole('heading', { name: 'You take part in benchmarking' }).waitFor();
  await metrics.getByText('Peers’ median').waitFor();

  // Five more participants, all owned by this user, share their gross margin.
  for (const [i, cost] of ['80000.00', '70000.00', '60000.00', '50000.00', '40000.00'].entries()) {
    const o = await call('/v1/orgs', { name: `E2E Bench Peer ${i + 1}`, countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 });
    assert.equal(o.status, 201);
    peers.push(o.body.id);
    await books(o.body.id, '100000.00', cost); // 20% to 60%
    assert.equal((await call(`/v1/orgs/${o.body.id}/benchmarking/participation`, { ...join, metrics: ['GROSS_MARGIN'] }, 'PUT')).status, 200);
  }
  await page.goto(`${WEB}/orgs/${orgId}/benchmarking`);
  const gm = metrics.getByRole('row', { name: /Gross margin/ });
  await gm.getByText('40.0%').waitFor();
  await gm.getByText('Better than the median').waitFor();
  await gm.getByText('Peers: Education, More than 250 people, IN (5 to 9)').waitFor();
  await gm.getByText('Needs 10+').waitFor();
  await metrics.getByRole('row', { name: /Net margin/ }).getByText(/Fewer than 5 other participants/).waitFor();

  // Share only gross margin.
  await page.getByRole('button', { name: 'Change what I share' }).click();
  for (const name of ['Net margin', 'Revenue growth', 'Operating expense ratio', 'Days sales outstanding', 'Days payables outstanding', 'Working capital efficiency', 'Revenue per employee', 'Project profitability', 'Cash conversion cycle'])
    await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await page.getByLabel(/I agree, on behalf of/).check();
  await page.getByRole('button', { name: 'Save what I share' }).click();
  await page.getByText(/Sharing 1 of 10 metrics/).waitFor();
  await metrics.getByRole('row', { name: /Net margin/ }).getByText('You do not share this metric, so it is not compared.').waitFor();

  // Withdraw.
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByText(/You withdrew on .* Your contribution was deleted from the pool\./).waitFor();
  await page.getByRole('button', { name: 'Join and compare' }).waitFor();
  assert.equal((await call(`/v1/orgs/${orgId}/benchmarking`)).body.comparison, null);
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
