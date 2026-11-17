/**
 * Browser end-to-end test for unbilled revenue detection (AR-042): a milestone marked complete and
 * a draft invoice left waiting show under Sales → Unbilled revenue with their amounts; the draft is
 * dismissed with a reason, found under Dismissed and brought back; the milestone opens its order.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const long = (iso) => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
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

test('revenue earned but not invoiced is found, dismissed with a reason and brought back', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Billing Owner');
  await page.getByLabel('Email').fill(`e2e-unbilled-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Unbilled Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = async (name) => (await call(`${B}/contacts`, { name, isCustomer: true })).body;
  const pawar = await customer('Pawar Foods');
  const rao = await customer('Rao Textiles');
  const line = (unitPrice) => ({ accountId: acc['4100'], description: 'Services', quantity: '1', unitPrice });
  const order = (await call(`${B}/sales/orders`, { contactId: pawar.id, orderDate: T, lines: [line('200000.00')] })).body;
  assert.equal((await call(`${B}/sales/orders/${order.id}/billing-method`, { method: 'MILESTONES' }, 'PUT')).status, 200);
  const ms = (await call(`${B}/sales/orders/${order.id}/milestones`, { milestones: [{ name: 'Design signed off', percent: '30' }, { name: 'Go-live', percent: '70' }] }, 'PUT')).body.milestones;
  assert.equal((await call(`${B}/sales/orders/${order.id}/milestones/${ms[0].id}/complete`, { done: true })).status, 200);
  assert.equal((await call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: rao.id, issueDate: addDays(T, -10), reference: 'Oct dyeing', lines: [line('7500.00')] })).status, 201);

  await page.goto(`${O}/sales/customers`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Unbilled revenue' }).click();
  await page.waitForURL(/\/sales\/unbilled-revenue$/);
  const list = page.locator('[aria-label="Findings"]');
  const draft = list.getByRole('row', { name: /Rao Textiles/ });
  await draft.getByText(`Draft invoice dated ${long(addDays(T, -10))} (Oct dyeing)`).waitFor();
  assert.match(await draft.innerText(), /₹7,500/);
  assert.match(await draft.innerText(), /10 days/);
  const milestone = list.getByRole('row', { name: /Pawar Foods/ });
  await milestone.getByText('Due now').waitFor();
  assert.match(await milestone.innerText(), /₹60,000/);
  await page.getByText('₹67,500').first().waitFor();

  // Dismiss the draft with a reason; it moves to Dismissed and the total drops.
  await draft.getByRole('button', { name: 'Dismiss' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Reason').fill('Customer asked us to hold this until the reprint');
  await dlg.getByRole('button', { name: 'Dismiss' }).click();
  await dlg.waitFor({ state: 'detached' });
  assert.equal(await list.getByRole('row', { name: /Rao Textiles/ }).count(), 0);
  await page.getByText('₹60,000').first().waitFor();
  await list.getByLabel('Show').selectOption('dismissed');
  await list.getByText(/Dismissed .* by Billing Owner: Customer asked us to hold this until the reprint/).waitFor();
  await list.getByRole('button', { name: 'Bring back' }).click();
  await dlg.getByLabel('Reason').fill('Reprint done');
  await dlg.getByRole('button', { name: 'Bring back' }).click();
  await dlg.waitFor({ state: 'detached' });
  await list.getByText('Nothing dismissed').waitFor();

  // The milestone opens its order to bill it.
  await list.getByLabel('Show').selectOption('open');
  await list.getByRole('link', { name: /Design signed off/ }).click();
  await page.waitForURL(new RegExp(`/sales/orders/${order.id}$`));
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
