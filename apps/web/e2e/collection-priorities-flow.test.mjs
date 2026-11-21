/**
 * Browser end-to-end test for collection priorities (AR-034): an owner records a customer 75 days
 * past due, one 10 days past due, and one whose overdue invoice is disputed on the dispute page;
 * Collection priorities ranks the oldest first with a call, the newer one with a reminder, the
 * disputed one with settling the dispute, and the score opens to show its points.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('customers are ranked by who to chase first, with the action and the points', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Chitra Chase');
  await page.getByLabel('Email').fill(`e2e-chase-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Chase Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const fy = await must(call(`${B}/periods`));
  if (!fy.some((p) => p.startDate <= addDays(T, -120))) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(fy[0].startDate.slice(0, 4)) - 1 });
  const customer = (name) => must(call(`${B}/contacts`, { name, isCustomer: true, email: `ap@${name.split(' ')[0].toLowerCase()}.test` }));
  const invoice = (who, issueDate, amount) => must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: who.id, issueDate, dueDate: addDays(issueDate, 30), post: true, lines: [{ accountId: acc('4100'), quantity: '1', unitPrice: amount }] }));
  const old = await customer('Oldham Metals');
  const fresh = await customer('Freshway Foods');
  const fight = await customer('Fightback Fabrics');
  // Someone paid once, so predictions have history.
  const paid = await invoice(fresh, addDays(T, -100), '1000');
  await must(call(`${B}/sales/payments`, { contactId: fresh.id, date: addDays(T, -70), bankAccountId: acc('1120'), amount: '1000.00', allocations: [{ documentId: paid.id, amount: '1000.00' }] }));
  await invoice(old, addDays(T, -105), '80000');
  await invoice(fresh, addDays(T, -40), '20000');
  const disputed = await invoice(fight, addDays(T, -45), '15000');
  await must(call(`${B}/sales/disputes`, { documentId: disputed.id, reason: 'QUALITY', description: 'Rolls arrived torn' }));

  await page.goto(`${base}/sales/collection-priorities`);
  const table = page.getByRole('table', { name: 'Collection priorities' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  assert.equal(await rows.count(), 3);
  const text = await rows.allInnerTexts();
  assert.match(text[0], /Oldham Metals/);
  assert.match(text[0], /Call, and consider a credit hold/);
  assert.match(text[0], /75 days/);
  assert.match(text[1], /Freshway Foods/);
  assert.match(text[1], /Send a reminder/);
  assert.match(text[2], /Fightback Fabrics/);
  assert.match(text[2], /Settle the dispute first/);
  assert.match(text[2], /disputed/);
  await rows.nth(0).getByText(/\/ 100$/).click();
  await rows.nth(0).getByText(/40\/40 Money to chase/).waitFor();
  await page.getByText('Overdue, not disputed').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/collection-priorities.png`, fullPage: true });
  await rows.nth(0).getByRole('link', { name: 'Oldham Metals' }).click();
  await page.waitForURL(new RegExp(`/sales/customers/${old.id}`));
  assert.deepEqual(consoleErrors, []);
});
