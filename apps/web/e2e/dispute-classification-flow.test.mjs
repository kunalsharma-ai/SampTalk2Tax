/**
 * Browser end-to-end test for dispute classification (AR-037): raising a dispute from an invoice,
 * the likely reason is suggested as the customer's words are typed and applied with one click; a
 * dispute recorded with a reason that looks wrong is flagged in the list and on the dispute.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
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


test('the likely reason is suggested while raising a dispute, and a wrong one is flagged', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dhruv Disputes');
  await page.getByLabel('Email').fill(`e2e-dispclass-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Dispute Reasons Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Cedar Mart', isCustomer: true })).body;
  const doc = async (amount, ago) => (await call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: addDays(T, -ago), dueDate: addDays(T, 15 - ago), post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] })).body;
  const chairs = await doc('18000', 12);
  const desks = await doc('9000', 8);
  // Recorded as Other, though the customer says the goods arrived damaged.
  assert.equal((await call(`${B}/sales/disputes`, { documentId: desks.id, reason: 'OTHER', description: 'Two desks arrived damaged and one drawer is broken' })).status, 201);

  await page.goto(`${O}/sales/invoices/${chairs.id}`);
  await page.getByRole('link', { name: 'Raise dispute…' }).click();
  const dialog = page.getByRole('dialog', { name: `Raise a dispute on ${chairs.number}` });
  await dialog.waitFor();
  await dialog.getByLabel('What the customer disputes').fill('Only received 40 chairs; 10 boxes missing from the delivery');
  const hint = dialog.getByRole('status', { name: 'Suggestion from the description' });
  await hint.getByText('Quantity', { exact: true }).waitFor();
  assert.match(await hint.innerText(), /Looks like Quantity \(high confidence\): "only received", "boxes missing"/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dispute-reason-suggestion.png`, fullPage: true });
  await hint.getByRole('button', { name: 'Use quantity' }).click();
  assert.equal(await dialog.locator('select').first().inputValue(), 'QUANTITY');
  await hint.getByRole('button').waitFor({ state: 'detached' });
  await dialog.getByRole('button', { name: 'Raise dispute' }).click();
  await page.getByRole('heading', { name: /^Dispute DS-/ }).waitFor();

  await page.goto(`${O}/sales/disputes`);
  const rows = page.getByRole('table').first().locator('tbody tr');
  await rows.first().waitFor();
  const text = await rows.allInnerTexts();
  const flagged = text.filter((t) => t.includes('Looks like quality or damage'));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /Other/);
  assert.ok(text.some((t) => /Quantity/.test(t) && !t.includes('Looks like')));
  assert.deepEqual(consoleErrors, []);
});
