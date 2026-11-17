/**
 * Browser end-to-end test for financial tags (GL-031) and locations (GL-028): the owner adds the
 * Location tag with two offices, tags a journal line on the form, and sees profit split by
 * location with untagged lines in their own column. Real Next.js app → real API → real MongoDB.
 * Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);

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
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('locations are defined, used on a journal line and reported by', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tag Owner');
  await page.getByLabel('Email').fill(`e2e-tags-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Locations Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));

  // Before any tag is defined, the journal form has no tag fields.
  await page.goto(`${WEB}/orgs/${orgId}/journals/new`);
  await page.getByLabel('Account for line 1').waitFor();
  assert.equal(await page.getByLabel('Location for line 1').count(), 0);

  await page.getByRole('link', { name: 'Locations and tags', exact: true }).click();
  await page.getByRole('heading', { name: 'Locations and tags', exact: true }).waitFor();
  await page.getByText('No tags yet').waitFor();
  await page.getByRole('button', { name: 'Location', exact: true }).click();
  await page.getByLabel('Code for value 1').fill('pune');
  await page.getByLabel('Name for value 1').fill('Pune office');
  await page.getByRole('button', { name: 'Add a value' }).click();
  await page.getByLabel('Code for value 2').fill('MUM');
  await page.getByLabel('Name for value 2').fill('Mumbai store');
  await page.getByRole('button', { name: 'Add tag' }).click();
  await page.getByRole('list', { name: 'Location values' }).getByText('Mumbai store').waitFor();
  await page.getByText('Key location · 2 active of 2').waitFor();
  await shot('01-locations');

  // A journal line tagged on the form.
  await page.goto(`${WEB}/orgs/${orgId}/journals/new`);
  await page.getByLabel('Memo').fill('Pune office rent');
  await page.getByLabel('Account for line 1').selectOption(acc['6200']);
  await page.getByLabel('Debit for line 1').fill('12000');
  await page.getByLabel('Location for line 1').selectOption({ label: 'Pune office' });
  await page.getByLabel('Account for line 2').selectOption(acc['1120']);
  await page.getByLabel('Credit for line 2').fill('12000');
  await page.getByRole('button', { name: 'Post journal' }).click();
  await page.waitForURL(/\/journals\/[0-9a-f-]{36}$/);
  await page.getByRole('row', { name: /Rent/ }).getByText('Pune office').waitFor();
  const je = (await call(`${base}/journals/${page.url().split('/').pop()}`)).body;
  assert.deepEqual(je.lines[0].dimensions, { location: 'PUNE' });

  // Sales at both offices and one untagged, posted through the API.
  for (const [amount, loc] of [['50000.00', 'PUNE'], ['30000.00', 'MUM'], ['4000.00', null]]) {
    const r = await call(`${base}/journals`, { date: T, memo: 'Sales', post: true, lines: [
      { accountId: acc['1120'], debit: amount },
      { accountId: acc['4100'], credit: amount, ...(loc ? { dimensions: { location: loc } } : {}) },
    ] });
    assert.equal(r.status, 201);
  }
  const wrong = await call(`${base}/journals`, { date: T, memo: 'Wrong', post: true, lines: [
    { accountId: acc['1120'], debit: '1.00' },
    { accountId: acc['4100'], credit: '1.00', dimensions: { location: 'DEL' } },
  ] });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.message, 'Line 2: DEL is not a Location');

  await page.goto(`${WEB}/orgs/${orgId}/reports/profit-by-dimension`);
  await page.getByRole('tab', { name: 'By location' }).click();
  const table = page.getByRole('table', { name: 'Profit by location' });
  await table.waitFor();
  const heads = await table.locator('thead th').allTextContents();
  assert.deepEqual(heads, ['Account', 'Pune office', 'Mumbai store', 'Not tagged', 'Total']);
  const net = await table.locator('tfoot tr').first().textContent();
  assert.match(net, /38,000\.00/);
  assert.match(net, /30,000\.00/);
  assert.match(net, /72,000\.00/);
  await shot('02-profit-by-location');
  // The one refused journal above is the only error.
  assert.deepEqual(consoleErrors.filter((e) => !/status of 422/.test(e)), []);
  assert.equal(consoleErrors.length, 1);
});
