/**
 * Browser end-to-end test for duplicate files across records (DOC-018): the owner attaches a vendor
 * invoice to one bill, then the same file to a second bill on screen; the Attachments card warns
 * and links the first bill, and Duplicate files lists it to check first. Real Next.js app → real
 * API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const PDF = `%PDF-1.4\n% synthetic vendor invoice ${randomUUID()}\n%%EOF\n`;
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

test('the same vendor invoice on two bills is flagged', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dup Owner');
  await page.getByLabel('Email').fill(`e2e-dupfiles-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Duplicate Files Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = (await call(`${base}/contacts`, { name: 'Synthetic Supplies', isVendor: true })).body;
  const bills = [];
  for (const ref of ['INV-77', 'INV-77-COPY']) {
    const b = await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: T, reference: ref, lines: [{ accountId: acc['6600'], quantity: '1', unitPrice: '1000.00' }] });
    assert.equal(b.status, 201);
    bills.push(b.body.id);
  }
  const first = await page.evaluate(
    async ([u, text]) => (await fetch(`/api/t2t${u}`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t2t-csrf': '1' }, body: new TextEncoder().encode(text) })).status,
    [`${base}/attachments?entityType=DOCUMENT&entityId=${bills[0]}&fileName=inv-77.pdf`, PDF],
  );
  assert.equal(first, 201);

  await page.goto(`${WEB}/orgs/${orgId}/purchases/bills/${bills[1]}`);
  await page.locator('button', { hasText: 'Attach files' }).waitFor();
  await page.locator('input[type=file][aria-label="Attach files"]').setInputFiles({ name: 'inv-77 copy.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF) });
  const warning = page.getByText(/The same file is also on/);
  await warning.waitFor();
  await warning.getByRole('link', { name: /^Bill / }).waitFor();
  await warning.scrollIntoViewIfNeeded();
  await shot('duplicate-file-warning');

  await page.getByRole('link', { name: 'Duplicate files', exact: true }).click();
  await page.getByRole('heading', { name: 'Duplicate files', exact: true }).waitFor();
  const list = page.getByRole('list', { name: 'Duplicate files' });
  await list.getByText('Check first').waitFor();
  await list.getByText(/more than one bill/).waitFor();
  assert.equal(await list.getByRole('link', { name: /^Bill / }).count(), 2);
  await shot('duplicate-files');
  assert.deepEqual(consoleErrors, []);
});
