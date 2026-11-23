/**
 * Browser end-to-end test for transaction history (AUDIT-005): an invoice is drafted, changed,
 * posted and paid in part, and a file is attached; its page shows the whole history from the
 * audit trail, with the money applied and the file; the receipt's page shows its own; a viewer,
 * who cannot read the audit trail, does not see it. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, owner, employee;
const consoleErrors = [];

async function call(page, path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };
async function register(page, name, email) {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
}

before(async () => {
  browser = await chromium.launch();
  owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  employee = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, employee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('transaction history: an invoice and its receipt tell their story from the audit trail', async () => {
  await register(owner, 'Kavya Books', `e2e-txhist-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Transaction History Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const customer = await must(call(owner, `${B}/contacts`, { name: 'Synthetic Retail LLP', isCustomer: true }));
  const lines = (price) => [{ accountId: acc['4100'], description: 'Synthetic consulting', quantity: '1', unitPrice: price }];
  const inv = await must(call(owner, `${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, dueDate: T, lines: lines('20000.00') }));
  await must(call(owner, `${B}/sales/documents/${inv.id}`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, dueDate: T, lines: lines('25000.00') }, 'PUT'));
  await must(call(owner, `${B}/sales/documents/${inv.id}/post`, {}));
  const receipt = await must(call(owner, `${B}/sales/payments`, { contactId: customer.id, date: T, bankAccountId: acc['1120'], amount: '10000.00', reference: 'NEFT-HIST-1', allocations: [{ documentId: inv.id, amount: '10000.00' }] }));
  const up = await owner.evaluate(
    async (u) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t2t-csrf': '1' }, body: new TextEncoder().encode('%PDF-1.4\n% synthetic signed purchase order 41\n%%EOF\n') })).status,
    `/api/t2t${B}/attachments?entityType=DOCUMENT&entityId=${inv.id}&fileName=signed-po.pdf`,
  );
  assert.equal(up, 201);

  await owner.goto(`${base}/sales/invoices/${inv.id}`);
  const card = owner.getByRole('region', { name: 'Transaction history' });
  await card.getByText('Posted to the books').waitFor();
  const text = await card.getByRole('list', { name: 'History events' }).innerText();
  for (const t of ['Draft created', 'Draft changed', 'Journal entry posted', 'Posted to the books', 'Money applied', 'File attached', 'signed-po.pdf', 'by Kavya Books']) assert.ok(text.includes(t), `history shows ${t}:\n${text}`);
  // Oldest first.
  assert.ok(text.indexOf('Draft created') < text.indexOf('Posted to the books') && text.indexOf('Posted to the books') < text.indexOf('Money applied'), text);
  await card.scrollIntoViewIfNeeded();
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/transaction-history.png`, fullPage: true });

  await owner.goto(`${base}/sales/receipts/${receipt.id}`);
  const rcard = owner.getByRole('region', { name: 'Transaction history' });
  await rcard.getByText('Payment recorded').waitFor();
  await rcard.getByText('Money applied').first().waitFor();
  assert.deepEqual(consoleErrors, []);

  // A viewer cannot read the audit trail, so the history is not shown.
  const email = `e2e-txhist-viewer-${randomUUID()}@example.test`;
  await register(employee, 'Vikram Viewer', email);
  await must(call(owner, `${B}/members`, { email, role: 'VIEWER' }));
  await employee.goto(`${base}/sales/invoices/${inv.id}`);
  await employee.getByRole('heading', { name: /INV-/ }).first().waitFor();
  assert.equal(await employee.getByRole('region', { name: 'Transaction history' }).count(), 0);
});
