/**
 * Browser end-to-end test for vendor risk monitoring (AP-024): two vendors are given the same bank
 * account, Purchases → Vendor risk lists them as high risk waiting for review, Alerts raises the
 * same, a review is refused without a proper note and then recorded on the vendor's page, and the
 * vendor leaves the waiting list.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page;
const consoleErrors = [];

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
after(async () => browser?.close());

test('vendors sharing a bank account are flagged, alerted and reviewed', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Risk Owner');
  await page.getByLabel('Email').fill(`e2e-vendor-risk-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Vendor Risk Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = async (name, amount, account) => {
    const v = (await call(`${B}/contacts`, { isVendor: true, name })).body;
    assert.equal((await call(`${B}/purchases/documents`, { kind: 'BILL', contactId: v.id, issueDate: T, dueDate: addDays(T, 30), lines: [{ accountId: acc['6600'], description: 'Tools', quantity: '1', unitPrice: amount }], post: true })).status, 201);
    assert.equal((await call(`${B}/contacts/${v.id}/bank-details`, { accountName: name, accountNumber: account, ifsc: 'HDFC0001234' }, 'PUT')).status, 200);
    return v;
  };
  const godavari = await vendor('Godavari Tools', '8000.00', '5010 0012 3456');
  await vendor('Krishna Tools', '2000.00', '501000123456');

  await page.goto(`${O}/purchases/vendors`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Vendor risk' }).click();
  await page.waitForURL(/\/purchases\/vendor-risk$/);
  const list = page.locator('[aria-label="Vendors"]');
  const g = list.getByRole('row', { name: /Godavari Tools/ });
  await g.getByText('Bank account shared with another vendor').waitFor();
  await g.getByText('Not reviewed yet').waitFor();
  assert.match(await g.innerText(), /High/);
  assert.match(await g.innerText(), /80\.0% of purchases/);
  assert.equal(await list.locator('tbody tr').count(), 2);

  // Alerts raises the same vendors.
  await page.goto(`${O}/alerts`);
  await page.getByRole('button', { name: 'Run checks now' }).click();
  await page.getByRole('button', { name: 'Critical: Godavari Tools: high vendor risk, nobody has reviewed it yet' }).waitFor();

  // Review it on the vendor's page.
  await page.goto(`${O}/purchases/vendors/${godavari.id}`);
  const card = page.locator('[aria-label="Vendor risk"]');
  await card.getByText('High risk').waitFor();
  await card.getByText(/The same bank account is on Krishna Tools/).waitFor();
  const form = card.locator('[aria-label="Record a review"]');
  assert.equal(await form.getByLabel('Review again by').inputValue(), addDays(T, 30));
  await form.getByLabel('Decision').selectOption('STOP');
  await form.getByLabel('What was looked at and why').fill('ok');
  await form.getByRole('button', { name: 'Record review' }).click();
  await card.getByText('Say what was looked at and why this decision').waitFor();
  await form.getByLabel('What was looked at and why').fill('Krishna denies this account; payments to both held until confirmed');
  await form.getByRole('button', { name: 'Record review' }).click();
  const reviews = card.getByRole('table', { name: 'Risk reviews' });
  await reviews.getByText('Stop new orders').waitFor();
  await reviews.getByText('Risk Owner').waitFor();
  assert.equal(await card.getByText('Not reviewed yet').count(), 0);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Vendor risk' }).click();
  await list.getByRole('row', { name: /Krishna Tools/ }).waitFor();
  assert.equal(await list.getByRole('row', { name: /Godavari Tools/ }).count(), 0);
  await list.getByLabel('Which vendors').selectOption('all');
  await list.getByRole('row', { name: /Godavari Tools/ }).getByText('Stop new orders').waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
