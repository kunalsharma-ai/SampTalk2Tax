/**
 * Browser end-to-end test for attachments and approvals: an owner sets a rule for
 * bills, attaches a receipt to a draft and submits it; the owner cannot approve their
 * own bill; a second person with the Approver role approves and posts it.
 * Real Next.js app → real API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PDF = Buffer.from('%PDF-1.4\n% synthetic e2e receipt\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let browser, owner, approver, base, orgId, billId;
const consoleErrors = [];
const approverEmail = `e2e-approver-${randomUUID()}@example.test`;

async function call(page, path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

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
  approver = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, approver]) {
    p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    p.on('dialog', (d) => d.accept());
  }
});
after(async () => browser?.close());

test('an owner sets an approval rule for bills', async () => {
  await register(owner, 'Rule Owner', `e2e-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Approvals Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  base = owner.url();
  orgId = base.split('/').pop();
  await owner.getByRole('link', { name: 'Approval rules' }).click();
  await owner.getByRole('button', { name: 'Edit the rule for bills' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('For totals of at least').fill('10000');
  await dialog.getByRole('button', { name: 'Save rule' }).click();
  await dialog.waitFor({ state: 'detached' });
  await owner.getByRole('row', { name: /Bills\s+On/ }).waitFor();
});

test('a receipt is attached to a draft bill, which cannot post until approved', async () => {
  const acc = Object.fromEntries((await call(owner, `/v1/orgs/${orgId}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = await call(owner, `/v1/orgs/${orgId}/contacts`, { name: 'Synthetic Steel', isVendor: true });
  const bill = await call(owner, `/v1/orgs/${orgId}/purchases/documents`, { kind: 'BILL', contactId: vendor.body.id, issueDate: new Date().toISOString().slice(0, 10), lines: [{ accountId: acc['1300'], quantity: '1', unitPrice: '25000.00' }] });
  assert.equal(bill.status, 201);
  billId = bill.body.id;
  await owner.goto(`${base}/purchases/bills/${billId}`);
  await owner.getByText(/need an approval before they can post/).waitFor();
  assert.ok(await owner.getByRole('button', { name: 'Post', exact: true }).isDisabled());

  await owner.getByLabel('Attach files').setInputFiles({ name: 'steel-invoice.pdf', mimeType: 'application/pdf', buffer: PDF });
  await owner.getByRole('link', { name: 'steel-invoice.pdf' }).waitFor();
  // A file that only claims to be a PDF is refused.
  await owner.getByLabel('Attach files').setInputFiles({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html>not a pdf</html>') });
  await owner.getByText('Only PDF, PNG, JPEG and WebP files can be attached').waitFor();
  // The stored file comes back byte for byte, as a download in a sandbox.
  const dl = await owner.evaluate(async (href) => {
    const r = await fetch(href);
    return { type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), csp: r.headers.get('content-security-policy'), text: await r.text() };
  }, await owner.getByRole('link', { name: 'steel-invoice.pdf' }).getAttribute('href'));
  assert.equal(dl.type, 'application/pdf');
  assert.match(dl.disposition, /^inline; filename\*=UTF-8''steel-invoice\.pdf$/);
  assert.match(dl.csp, /sandbox/);
  assert.equal(dl.text, PDF.toString());

  await owner.getByRole('button', { name: 'Submit for approval' }).click();
  await owner.getByRole('dialog').getByLabel('Note for the approver (optional)').fill('Steel for the October order');
  await owner.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await owner.getByText('Waiting for approval, submitted by Rule Owner. Someone other than you must approve it.').waitFor();
  assert.ok(await owner.getByRole('button', { name: 'Post', exact: true }).isDisabled());
});

test('the person who prepared the bill cannot approve it', async () => {
  await owner.getByRole('link', { name: 'Approvals', exact: true }).click();
  const row = owner.getByRole('row', { name: /Synthetic Steel/ });
  await row.getByText('Needs someone else').waitFor();
  assert.equal(await row.getByRole('button', { name: 'Approve…' }).count(), 0);
});

test('an approver approves and posts it', async () => {
  await register(approver, 'Second Approver', approverEmail);
  const added = await call(owner, `/v1/orgs/${orgId}/members`, { email: approverEmail, role: 'APPROVER' });
  assert.equal(added.status, 201);
  await approver.goto(`${WEB}/orgs/${orgId}/approvals`);
  const row = approver.getByRole('row', { name: /Synthetic Steel/ });
  await row.getByText('Steel for the October order').waitFor();
  await row.getByRole('button', { name: 'Approve…' }).click();
  const dialog = approver.getByRole('dialog');
  await dialog.getByLabel('Note (optional)').fill('Matches the purchase order');
  await dialog.getByRole('button', { name: 'Approve and post' }).click();
  await dialog.waitFor({ state: 'detached' });
  await approver.getByText('Nothing is waiting for approval').waitFor();
  await approver.getByRole('tab', { name: 'Approved' }).click();
  await approver.getByRole('link', { name: /Bill BILL-000001/ }).click();
  await approver.getByRole('heading', { name: 'Bill BILL-000001' }).waitFor();
  await approver.getByText(/Second Approver: Matches the purchase order/).waitFor();
  // An approver can read purchases but not change their files.
  await approver.getByRole('link', { name: 'steel-invoice.pdf' }).waitFor();
  assert.equal(await approver.getByRole('button', { name: 'Attach files' }).count(), 0);
});

test('no unexpected console errors were logged', () => {
  // The refused upload logs one failed request (415) in the browser console; that is expected.
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|status of 415/.test(e)), [], consoleErrors.join('\n'));
});
