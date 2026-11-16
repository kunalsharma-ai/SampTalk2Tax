/**
 * Browser end-to-end test for bad debts: an owner creates the usual bad-debt accounts, reads the
 * provision matrix built from the ageing, marks an invoice doubtful at its own percentage, posts
 * the provision, writes off an overdue invoice from its own page (the allowance refuses more than
 * it holds, so the rest goes to the expense), sees the invoice settled, and reverses a write-off.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
let browser, page, orgId;
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

test('the allowance follows the ageing, and invoices are written off and reversed', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Bad Debts Owner');
  await page.getByLabel('Email').fill(`e2e-bad-debts-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Bad Debts Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/orgs/')[1];
  const base = `/v1/orgs/${orgId}`;
  const periods = (await call(`${base}/periods`)).body;
  const fyStart = periods.map((p) => p.startDate).sort()[0];
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${base}/contacts`, { name: 'Slow Payer Traders', isCustomer: true, paymentTermsDays: 30 })).body;
  const invoice = async (date, price) => {
    const d = (await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: date, lines: [{ accountId: acc['4100'], description: 'Goods', quantity: '1', unitPrice: price }] })).body;
    const r = await call(`${base}/sales/documents/${d.id}/post`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  // Over 90 days overdue at 50%, and 1-30 days overdue at 3%.
  const a = await invoice(fyStart, '100000');
  const b = await invoice(addDays(T, -45), '20000');

  // First visit: the settings, and the usual accounts made in one click.
  await page.goto(`${WEB}/orgs/${orgId}/sales/bad-debts`);
  await page.getByRole('heading', { name: 'Bad debts' }).waitFor();
  await page.getByText('Bad-debt settings').waitFor();
  await page.getByRole('button', { name: 'Create the usual accounts' }).click();
  await page.getByRole('button', { name: 'Post provision…' }).waitFor();
  const matrix = page.getByRole('table', { name: 'Provision matrix' });
  await matrix.getByRole('row', { name: /Over 90 days.*50%.*50,000\.00/ }).waitFor();
  await matrix.getByRole('row', { name: /1-30 days.*3%.*600\.00/ }).waitFor();
  await matrix.getByRole('row', { name: /Allowance needed.*1,20,000\.00.*50,600\.00/ }).waitFor();

  // A specific provision for the newer invoice.
  const open = page.getByRole('table', { name: 'Open invoices' });
  await open.getByRole('row', { name: new RegExp(b.number) }).getByRole('button', { name: 'Mark doubtful…' }).click();
  await page.getByLabel('Percentage to provide').fill('100');
  await page.getByLabel('Why').fill('Customer has gone into insolvency');
  await page.getByRole('button', { name: 'Mark doubtful', exact: true }).click();
  await open.getByText('Doubtful 100%').waitFor();
  await matrix.getByRole('row', { name: /Allowance needed.*70,000\.00/ }).waitFor();

  // Post it: the whole 70,000 the first time.
  await page.getByRole('button', { name: 'Post provision…' }).click();
  await page.getByLabel('Note (optional)').fill('Half-year review');
  await page.getByRole('button', { name: 'Post provision', exact: true }).click();
  await page.getByText('PV-0001 saved').waitFor();
  await page.getByRole('table', { name: 'Provision history' }).getByRole('row', { name: /PV-0001/ }).waitFor();
  assert.equal((await call(`${base}/bad-debts?asOf=${T}`)).body.preview.adjustment, '0.00');
  await page.getByRole('link', { name: 'Open the journal' }).click();
  await page.getByText('Created by a bad-debt provision or write-off').waitFor();
  await page.getByText('Posted from Bad debts').waitFor();

  // Write off the old invoice from its own page.
  await page.goto(`${WEB}/orgs/${orgId}/sales/invoices/${a.id}`);
  await page.getByRole('link', { name: 'Write off…' }).click();
  await page.waitForURL(/sales\/bad-debts\?writeOff=/);
  const dialog = page.getByRole('dialog', { name: `Write off ${a.number}` });
  await dialog.waitFor();
  // The allowance holds 70,000: it cannot absorb the whole 1,00,000.
  await dialog.getByLabel('Reason').fill('Customer dissolved; nothing will be paid');
  await dialog.getByRole('button', { name: 'Write off' }).click();
  await dialog.getByText('less than this write-off').waitFor();
  await dialog.getByLabel('Amount (INR)').fill('50000');
  await dialog.getByRole('button', { name: 'Write off' }).click();
  await dialog.waitFor({ state: 'detached' });
  const offs = page.getByRole('table', { name: 'Write-offs' });
  await offs.getByRole('row', { name: /WO-0001.*50,000\.00/ }).waitFor();
  // The rest against the expense.
  await open.getByRole('row', { name: new RegExp(a.number) }).getByRole('button', { name: 'Write off…' }).click();
  const second = page.getByRole('dialog', { name: `Write off ${a.number}` });
  assert.equal(await second.getByLabel('Amount (INR)').inputValue(), '50000.00');
  await second.getByLabel('Charge it to').selectOption('EXPENSE');
  await second.getByLabel('Reason').fill('Customer dissolved; nothing will be paid');
  await second.getByRole('button', { name: 'Write off' }).click();
  await second.waitFor({ state: 'detached' });
  await offs.getByRole('row', { name: /WO-0002.*6950/ }).waitFor();
  assert.equal(await open.getByRole('row', { name: new RegExp(a.number) }).count(), 0);
  // Only the doubtful invoice is left, and the allowance already holds exactly what it needs.
  await page.getByText('The books already match').waitFor();

  // The invoice shows the write-offs and has nothing left to pay.
  await page.goto(`${WEB}/orgs/${orgId}/sales/invoices/${a.id}`);
  await page.getByRole('link', { name: 'Bad-debt write-off WO-0001' }).waitFor();
  await page.getByRole('link', { name: 'Bad-debt write-off WO-0002' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove' }).count(), 0);
  assert.equal((await call(`${base}/sales/documents/${a.id}`)).body.amountDue, '0.00');

  // The customer statement shows the write-off, linked to Bad debts.
  await page.goto(`${WEB}/orgs/${orgId}/sales/customers/${customer.id}`);
  await page.getByText('Written off as a bad debt').first().waitFor();
  assert.match(await page.getByRole('link', { name: 'WO-0001' }).getAttribute('href'), /sales\/bad-debts$/);

  // The customer pays half after all: reverse the expense write-off.
  await page.goto(`${WEB}/orgs/${orgId}/sales/bad-debts`);
  await offs.getByRole('row', { name: /WO-0002/ }).getByRole('button', { name: 'Reverse…' }).click();
  await page.getByLabel('Reason').fill('Customer paid after all');
  await page.getByRole('button', { name: 'Reverse write-off' }).click();
  await offs.getByRole('row', { name: /WO-0002.*Reversed/ }).waitFor();
  await open.getByRole('row', { name: new RegExp(a.number) }).waitFor();
  assert.equal((await call(`${base}/sales/documents/${a.id}`)).body.amountDue, '50000.00');

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
