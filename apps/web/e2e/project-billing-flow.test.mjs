/**
 * Browser end-to-end test for milestone billing (AR-013) and progress billing (AR-014) of sales
 * orders: choose milestones, plan three, mark one reached and make its draft invoice for its share;
 * on a second order choose progress, claim 40% and see the draft invoice and the claim recorded.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

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

test('an order is billed by milestones, another by progress claims', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Project Billing Owner');
  await page.getByLabel('Email').fill(`e2e-project-billing-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Projects Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Kapoor Studios', isCustomer: true })).body;
  const order = async () => (await call(`${B}/sales/orders`, { contactId: customer.id, orderDate: T, lines: [{ accountId: acc['4100'], description: 'Website build', quantity: '1', unitPrice: '200000' }] })).body;

  // Milestones.
  const a = await order();
  await page.goto(`${O}/sales/orders/${a.id}`);
  await page.getByRole('heading', { name: 'How this order is billed' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Bill this order' }).count(), 1);
  await page.getByLabel('Billing method').selectOption('MILESTONES');
  await page.getByRole('button', { name: 'Plan milestones' }).click();
  await page.getByLabel('Milestone 1 name').fill('Design signed off');
  await page.getByLabel('Milestone 1 share').fill('30');
  await page.getByRole('button', { name: 'Add milestone' }).click();
  await page.getByLabel('Milestone 2 name').fill('Site live');
  await page.getByLabel('Milestone 2 share').fill('80');
  await page.getByText('Total 110%').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save milestones' }).isDisabled(), true);
  await page.getByLabel('Milestone 2 share').fill('70');
  await page.getByRole('button', { name: 'Save milestones' }).click();
  const table = page.getByRole('table', { name: 'Milestones' });
  await table.getByText('Site live').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Bill this order' }).count(), 0);
  await table.getByRole('row', { name: /Design signed off/ }).getByRole('button', { name: 'Mark reached' }).click();
  await table.getByRole('row', { name: /Design signed off/ }).getByRole('button', { name: 'Make invoice…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Make draft invoice' }).click();
  await page.waitForURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  const inv = page.url().split('/').pop();
  const d = (await call(`${B}/sales/documents/${inv}`)).body;
  assert.equal(d.total, '60000.00');
  assert.equal(d.memo, 'Milestone: Design signed off (30%)');
  await page.goto(`${O}/sales/orders/${a.id}`);
  await page.getByText('30% of the order is invoiced; the plan covers 100%.').waitFor();
  assert.equal(await page.getByLabel('Billing method').isDisabled(), true);

  // Progress.
  const b = await order();
  await page.goto(`${O}/sales/orders/${b.id}`);
  await page.getByLabel('Billing method').selectOption('PROGRESS');
  await page.getByRole('button', { name: 'Claim progress…' }).click();
  await page.getByLabel('Percent complete').fill('40');
  await page.getByLabel('Note (optional)').fill('Wireframes done');
  await page.getByText('This claim bills 40% more of the order').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Make draft invoice' }).click();
  await page.waitForURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  assert.equal((await call(`${B}/sales/documents/${page.url().split('/').pop()}`)).body.total, '80000.00');
  await page.goto(`${O}/sales/orders/${b.id}`);
  await page.getByRole('table', { name: 'Progress claims' }).getByText('Wireframes done').waitFor();
  await page.getByText('Claimed so far: 40% complete.').waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
