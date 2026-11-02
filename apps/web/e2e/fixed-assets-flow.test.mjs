/**
 * Browser end-to-end test for the fixed asset register: an owner adds an asset with its
 * purchase posted, posts two months of depreciation, reverses and re-posts the latest, and
 * disposes of the asset at a loss. Real Next.js app → real API → real PostgreSQL.
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
const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

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
after(async () => {
  await browser?.close();
});

test('an owner keeps a fixed asset from purchase to disposal', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Asset Owner');
  await page.getByLabel('Email').fill(`e2e-assets-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Assets Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const M = T.slice(0, 7);
  const m2 = shift(M, -2);
  const m1 = shift(M, -1);
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!years.has(fyOf(m2))) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(m2) })).status, 201);

  await page.getByRole('link', { name: 'Fixed assets', exact: true }).click();
  await page.getByRole('heading', { name: 'Fixed assets', exact: true }).waitFor();
  await page.getByText('No assets yet').waitFor();
  await page.getByRole('link', { name: 'Add asset' }).first().click();
  await page.getByRole('heading', { name: 'Add an asset' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Office furniture');
  await page.getByLabel('Category').fill('Furniture');
  await page.getByLabel('Acquired on').fill(`${m2}-05`);
  await page.getByLabel('Put to use on').fill(`${m2}-05`);
  await page.getByLabel('Cost', { exact: true }).fill('90000');
  await page.getByLabel('Useful life (months)').fill('36');
  await page.getByLabel('Paid from', { exact: true }).selectOption({ label: '1120 Operating Bank Account' });
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByRole('heading', { name: 'FA-0001 Office furniture' }).waitFor();
  const schedule = page.getByRole('table', { name: 'Depreciation schedule' });
  await schedule.getByRole('row').nth(1).getByText('₹87,500.00').waitFor();
  await page.getByText(/Journal #\d+/).first().waitFor();

  await page.getByRole('link', { name: 'Fixed assets', exact: true }).click();
  await page.getByRole('link', { name: 'Depreciation', exact: true }).click();
  const post = page.getByLabel('Post depreciation');
  await post.getByText(`Depreciation for ${label(m2)}`, { exact: true }).waitFor();
  await post.getByRole('button', { name: `Post depreciation for ${label(m2)}` }).click();
  await post.getByText(`Depreciation for ${label(m1)}`, { exact: true }).waitFor();
  await post.getByRole('button', { name: `Post depreciation for ${label(m1)}` }).click();
  await post.getByText(new RegExp(`Posted through`)).waitFor();
  const runs = page.getByRole('table', { name: 'Depreciation runs' });
  await runs.getByRole('row', { name: new RegExp(label(m1)) }).getByRole('button', { name: 'Reverse' }).click();
  await runs.getByRole('row', { name: new RegExp(label(m1)) }).getByText(/Reversed by Asset Owner/).waitFor();
  await post.getByRole('button', { name: `Post depreciation for ${label(m1)}` }).click();
  await runs.getByRole('row', { name: new RegExp(`${label(m1)}.*Posted`) }).waitFor();
  // Depreciation runs through the month of disposal.
  await post.getByText(`Depreciation for ${label(M)}`, { exact: true }).waitFor();
  await post.getByRole('button', { name: `Post depreciation for ${label(M)}` }).click();
  await runs.getByRole('row', { name: new RegExp(`${label(M)}.*Posted`) }).waitFor();

  await page.getByRole('link', { name: 'Register' }).click();
  await page.getByRole('link', { name: 'FA-0001 Office furniture' }).click();
  await page.getByText('₹82,500.00').first().waitFor();
  const dispose = page.getByLabel('Dispose of this asset');
  await dispose.getByRole('button', { name: 'Dispose of…' }).click();
  await dispose.getByLabel('Proceeds').fill('80000');
  await dispose.getByLabel('Gain or loss to').selectOption({ label: '4900 Other Income' });
  await dispose.getByText(/a loss of ₹2,500.00/).waitFor();
  await dispose.getByRole('button', { name: 'Dispose of FA-0001' }).click();
  await page.getByLabel('Disposal').getByText(/Proceeds ₹80,000.00/).waitFor();
  const reg = (await call(`${base}/fixed-assets`)).body;
  assert.equal(reg.assets[0].status, 'DISPOSED');
  assert.equal(reg.assets[0].accumulated, '7500.00');
  assert.deepEqual(consoleErrors, []);
});
