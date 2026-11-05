/**
 * Browser end-to-end test for opportunity intelligence: an owner with twelve months of sales finds
 * a lapsed customer, a line to cross-sell and a slipped margin, changes the win-back rate, and
 * takes the win-back forward into the business impact engine.
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


test('an owner finds growth opportunities in the books and takes one forward', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Ola Opportunity');
  await page.getByLabel('Email').fill(`e2e-opps-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Opportunity Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const M = (k) => shift(LAST, k - 11);
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const fy of new Set(Array.from({ length: 12 }, (_, k) => fyOf(M(k))))) if (!years.has(fy)) ok(await call(`${base}/periods/fiscal-years`, { fiscalYear: fy }), 'fiscal year');
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const wh = ok(await call(`${base}/accounts`, { code: '4150', name: 'Warehousing', type: 'REVENUE' }), 'account').id;
  const c = {};
  for (const n of ['Lapsed Ltd', 'Alpha', 'Beta', 'Gamma', 'Delta']) c[n] = ok(await call(`${base}/contacts`, { name: n, isCustomer: true }), n).id;
  const vendor = ok(await call(`${base}/contacts`, { name: 'Mill Supplies', isVendor: true }), 'vendor').id;
  const inv = (who, m, lines) => call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: c[who], issueDate: `${m}-02`, dueDate: `${m}-20`, post: true, lines: lines.map(([a, p]) => ({ accountId: a, quantity: '1', unitPrice: p })) });
  for (let k = 0; k < 12; k++) {
    const m = M(k);
    if (k < 6) ok(await inv('Lapsed Ltd', m, [[acc['4100'], '30000.00']]), 'lapsed');
    for (const n of ['Alpha', 'Beta', 'Gamma']) ok(await inv(n, m, [[acc['4100'], '20000.00'], [wh, '10000.00']]), n);
    ok(await inv('Delta', m, [[acc['4100'], '50000.00']]), 'delta');
    ok(await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: `${m}-03`, reference: `B-${m}`, post: true, lines: [{ accountId: acc['5000'], quantity: '1', unitPrice: k < 9 ? (k < 6 ? '68000.00' : '56000.00') : '70000.00' }] }), 'bill');
  }

  await page.goto(`${WEB}/orgs/${orgId}`);
  await page.getByRole('link', { name: 'Growth opportunities' }).click();
  await page.getByRole('heading', { name: 'Growth opportunities' }).waitFor();
  const summary = page.getByTestId('opportunities-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /^3 opportunities found in the books/);
  const win = page.getByRole('region', { name: /^Opportunity \d: Win back 1 lapsed customer$/ });
  assert.match(await win.getByRole('table').innerText(), /Lapsed Ltd\s+6/);
  await page.getByRole('region', { name: /^Opportunity \d: Sell Warehousing to 1 more customer$/ }).waitFor();
  await page.getByRole('region', { name: /^Opportunity \d: Restore gross margin to 60\.0%$/ }).waitFor();
  assert.match(await page.getByRole('table', { name: 'What was checked' }).innerText(), /No sales are tagged to departments or projects\./);
  const before = await win.getByText('Extra net profit').locator('..').innerText();

  // A higher win-back rate is a bigger opportunity; a bad one is explained.
  await page.getByLabel('Lapsed customers’ sales won back (%)').fill('150');
  await page.getByRole('button', { name: 'Look again' }).click();
  await page.getByText('Lapsed customers’ sales won back (%) must be a number above 0 and at most 100').waitFor();
  await page.getByLabel('Lapsed customers’ sales won back (%)').fill('50');
  await page.getByRole('button', { name: 'Look again' }).click();
  await page.getByTestId('opportunities-summary').waitFor();
  const win2 = page.getByRole('region', { name: /^Opportunity \d: Win back 1 lapsed customer$/ });
  await win2.waitFor();
  assert.match(await win2.innerText(), /50% of their former monthly sales comes back/);
  assert.notEqual(await win2.getByText('Extra net profit').locator('..').innerText(), before);

  // Into the business impact engine.
  await win2.getByRole('button', { name: 'Assess in business impact' }).click();
  await page.waitForURL(/\/planning\/impact\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Win back 1 lapsed customer' }).waitFor();
  await page.getByTestId('impact-summary').waitFor();
  assert.match(await page.getByRole('region', { name: 'Change 1: Win back: 1 lapsed customer' }).innerText(), /build up evenly to INR 10000\.00 a month/);
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|status of 422/.test(e)), []);
});
