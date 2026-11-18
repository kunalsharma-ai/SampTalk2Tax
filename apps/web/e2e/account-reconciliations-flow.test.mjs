/**
 * Browser end-to-end test for balance sheet account reconciliations (GL-032, GL-023): the owner
 * lists accounts at a date, explains the stock account with a count and a reconciling item, signs
 * off once nothing is unexplained, and an accountant reviews it in their own browser. The
 * receivable control account shows its ledger's open items. Real Next.js app → real API → real
 * MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page, other;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);

async function call(p, path, body, method = body ? 'POST' : 'GET') {
  return p.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

async function register(p, name, email) {
  await p.goto(`${WEB}/register`);
  await p.getByLabel('Full name').fill(name);
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill('e2e-very-long-password');
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.waitForURL(/\/onboarding/);
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  other = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [page, other]) p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a balance sheet account is explained, signed off and reviewed by someone else', async () => {
  const reviewerEmail = `e2e-recon-rev-${randomUUID()}@example.test`;
  await register(other, 'Riya Reviewer', reviewerEmail);
  await register(page, 'Recon Owner', `e2e-recon-${randomUUID()}@example.test`);
  await page.getByLabel('Organisation name').fill('E2E Reconciliations Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  assert.equal((await call(page, `${base}/members`, { email: reviewerEmail, role: 'ACCOUNTANT' })).status, 201);
  const acc = Object.fromEntries((await call(page, `${base}/accounts`)).body.map((a) => [a.code, a.id]));
  assert.equal((await call(page, `${base}/journals`, { date: T, memo: 'Stock bought', post: true, lines: [{ accountId: acc['1300'], debit: '12000.00' }, { accountId: acc['1120'], credit: '12000.00' }] })).status, 201);
  const c = (await call(page, `${base}/contacts`, { name: 'Asha Traders', isCustomer: true })).body;
  assert.equal((await call(page, `${base}/sales/documents`, { kind: 'INVOICE', contactId: c.id, issueDate: T, dueDate: T, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '5000.00' }] })).status, 201);

  await page.getByRole('link', { name: 'Account reconciliations', exact: true }).click();
  await page.getByRole('heading', { name: 'Account reconciliations', exact: true }).waitFor();
  await page.getByLabel('Reconcile to').fill(T);
  const table = page.getByRole('table', { name: 'Balance sheet accounts' });
  const stock = table.getByRole('row').filter({ hasText: '1300' });
  await stock.getByText('₹12,000.00').waitFor();
  await stock.getByText('Not started').waitFor();
  await table.getByRole('row').filter({ hasText: '1200' }).getByText('₹5,000.00').first().waitFor();
  await shot(page, 'account-reconciliations-list');

  // The receivable control account offers its ledger's open items.
  await table.getByRole('row').filter({ hasText: '1200' }).getByRole('link').first().click();
  await page.getByRole('button', { name: /Add open items in the receivables ledger/ }).click();
  assert.equal(await page.getByLabel('Amount of item 1').inputValue(), '5000.00');
  await page.getByRole('button', { name: 'All accounts' }).click();

  await table.getByRole('row').filter({ hasText: '1300' }).getByRole('link').first().click();
  await page.getByRole('heading', { name: /^1300 / }).waitFor();
  await page.getByLabel('What item 1 is').fill('Stock count at the month end');
  await page.getByLabel('Reference for item 1').fill('SC-31');
  await page.getByLabel('Amount of item 1').fill('12500.00');
  await page.getByRole('button', { name: 'Add an item' }).click();
  await page.getByLabel('What item 2 is').fill('Goods received not yet billed');
  await page.getByLabel('Kind of item 2').selectOption('RECONCILING');
  await page.getByLabel('Amount of item 2').fill('-400');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.getByText('Sign-off opens once nothing is unexplained.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sign off as preparer' }).isDisabled(), true);
  await page.getByLabel('Amount of item 2').fill('-500');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.getByRole('button', { name: 'Sign off as preparer' }).click();
  await page.getByText('Waiting for review').waitFor();
  await page.getByText('You prepared this, so someone else reviews it.').waitFor();
  await shot(page, 'account-reconciliation-prepared');

  // The accountant reviews it in their own browser.
  await other.goto(`${WEB}/orgs/${orgId}/account-reconciliations/${acc['1300']}?asOf=${T}`);
  await other.getByLabel('Review note (optional)').fill('Agreed to the count sheets');
  await other.getByRole('button', { name: 'Mark reviewed' }).click();
  await other.getByText('Reviewed', { exact: true }).first().waitFor();
  await other.getByText(/Reviewed by Riya Reviewer .*: Agreed to the count sheets/).waitFor();
  await shot(other, 'account-reconciliation-reviewed');

  await page.goto(`${WEB}/orgs/${orgId}/account-reconciliations?asOf=${T}`);
  await table.getByRole('row').filter({ hasText: '1300' }).getByText('Reviewed: Riya Reviewer').waitFor();
  assert.deepEqual(consoleErrors, []);
});
