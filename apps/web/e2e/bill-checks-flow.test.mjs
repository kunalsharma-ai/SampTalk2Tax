/**
 * Browser end-to-end test for unusual bill checks (AP-031): a vendor's ordinary bills, then one
 * reusing a vendor invoice number at four times the usual amount; it shows on Unusual bills, the
 * bill page explains each finding, and the owner marks it reviewed with a note.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const iso = (n) => new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
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

test('an unusual bill is listed, explained and reviewed', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Bill Check Owner');
  await page.getByLabel('Email').fill(`e2e-billcheck-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Bill Checks Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = (await call(`${base}/contacts`, { name: 'Paper Mart', isVendor: true })).body.id;
  const bill = async (issueDate, reference, unitPrice) => {
    const r = await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate, reference, post: true, lines: [{ accountId: acc['6600'], description: 'A4 paper, 10 reams', quantity: '1', unitPrice }] });
    assert.equal(r.status, 201);
    return r.body;
  };
  for (const [i, p] of [[1, '2400.00'], [2, '2500.00'], [3, '2450.00']]) await bill(iso(-80 + i * 20), `PM-${i}`, p);
  // The exact number is refused when posting; written differently it gets through.
  const odd = await bill(iso(-1), 'pm 2', '9800.00');

  await page.getByRole('link', { name: 'Unusual bills', exact: true }).click();
  await page.getByRole('heading', { name: 'Unusual bills' }).waitFor();
  const table = page.getByRole('table', { name: 'Bills to review' });
  const row = table.getByRole('row', { name: new RegExp(odd.number) });
  await row.getByText('Vendor invoice number used before').waitFor();
  await row.getByText('Much more than usual').waitFor();
  assert.equal(await table.getByRole('row').count(), 2);
  await shot('01-unusual-bills');

  await row.getByRole('link', { name: odd.number }).click();
  await page.waitForURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  const card = page.getByRole('region', { name: 'Unusual bill checks' });
  await card.getByText(/is 4 times the usual/).waitFor();
  await card.getByText(/9800\.00 a unit against 2450\.00/).waitFor();
  await card.getByRole('button', { name: 'Mark reviewed…' }).click();
  await card.getByLabel('Why the bill is fine').fill('Paper Mart split one order across two invoices; confirmed with their accounts team');
  await card.getByRole('button', { name: 'Save review' }).click();
  await card.getByText('Reviewed', { exact: true }).waitFor();
  await card.getByRole('note', { name: 'Last review' }).getByText(/confirmed with their accounts team/).waitFor();
  await card.scrollIntoViewIfNeeded();
  await shot('02-bill-reviewed');

  await page.goto(`${WEB}/orgs/${orgId}/purchases/bill-checks`);
  await page.getByText('Nothing unusual').waitFor();
  assert.deepEqual(consoleErrors, []);
});
