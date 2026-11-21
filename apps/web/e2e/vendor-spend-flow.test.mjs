/**
 * Browser end-to-end test for vendor spending (RPT-016): two vendors' bills show as spend by
 * vendor with their shares, by account and by month, and an account opens its ledger.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page, orgId;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function call(path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('vendor spend shows who the money went to, on what, against the period before', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Vendor Spend Owner');
  await page.getByLabel('Email').fill(`e2e-spend-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Vendor Spend Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();

  const base = `/v1/orgs/${orgId}`;
  const accounts = (await call(`${base}/accounts`)).body;
  const acc = Object.fromEntries((accounts.items ?? accounts).map((a) => [a.code, a.id]));
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const vendor = async (name) => (await call(`${base}/contacts`, { name, isVendor: true })).body.id;
  const landlord = await vendor('Synthetic Landlord');
  const cloud = await vendor('Synthetic Cloud');
  const bill = (contactId, ref, code, unitPrice) => call(`${base}/purchases/documents`, { kind: 'BILL', contactId, issueDate: today, dueDate: today, reference: ref, post: true, lines: [{ accountId: acc[code], quantity: '1', unitPrice }] });
  assert.equal((await bill(landlord, 'SYN-1', '6200', '40000.00')).status, 201);
  assert.equal((await bill(cloud, 'SYN-2', '6400', '10000.00')).status, 201);

  await page.goto(`${WEB}/orgs/${orgId}/reports/vendor-spend`);
  await page.getByRole('heading', { name: 'Spend by vendor' }).waitFor();
  const landlordRow = page.getByRole('row', { name: /Synthetic Landlord/ });
  await landlordRow.getByText('₹40,000.00').first().waitFor();
  await landlordRow.getByText('80.0%').waitFor();
  await page.getByRole('row', { name: /Synthetic Cloud/ }).getByText('20.0%').waitFor();
  await page.getByText('1 vendor makes up 80% of spend').waitFor();
  await page.getByRole('row', { name: /Software and Subscriptions/ }).getByText('₹10,000.00').waitFor();
  await shot('01-vendor-spend');
  await page.getByRole('link', { name: 'Rent' }).click();
  await page.waitForURL(/\/reports\/general-ledger\?accountId=/);
  assert.deepEqual(consoleErrors, []);
});
