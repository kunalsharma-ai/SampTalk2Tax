/**
 * Browser end-to-end test for missing receipt detection (EXP-021): two claims go in without a
 * receipt, one over the policy's receipt amount and approved anyway; finance finds them on the
 * Missing receipts page and asks for the receipt; the claimant sees the request on the approved
 * claim and attaches it; the claim leaves the list. Real Next.js app → real API → real MongoDB.
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

test('missing receipts: finance finds a claim without one and asks; the claimant attaches it after approval', async () => {
  await register(owner, 'Meera Finance', `e2e-missrc-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Missing Receipts Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const email = `e2e-missrc-emp-${randomUUID()}@example.test`;
  await register(employee, 'Arjun Road', email);
  await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));
  await must(call(owner, `${B}/expense-policy-rules`, { kind: 'RECEIPT_ABOVE', severity: 'WARN', amount: '500' }));
  // Two claims went in without receipts; one was approved with a note.
  const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const big = await must(call(employee, `${B}/expense-claims`, { title: 'Hyderabad client visit', lines: [{ date: T, accountId: acc['6700'], merchant: 'Synthetic Airways', amount: '7400.00' }] }));
  await must(call(employee, `${B}/expense-claims/${big.id}/submit`, {}));
  await must(call(owner, `${B}/expense-claims/${big.id}/approve`, { note: 'Urgent trip; receipt to follow' }));
  const small = await must(call(employee, `${B}/expense-claims`, { title: 'Parking', lines: [{ date: T, accountId: acc['6700'], merchant: 'Synthetic Parking', amount: '80.00' }] }));
  await must(call(employee, `${B}/expense-claims/${small.id}/submit`, {}));

  await owner.goto(`${base}/expenses/missing-receipts`);
  await owner.getByRole('heading', { name: 'Missing receipts', exact: true }).waitFor();
  const table = owner.getByRole('table', { name: 'Claims without receipts' });
  const row = table.getByRole('row').filter({ hasText: big.number });
  await row.getByText('Required by policy').waitFor();
  assert.match(await row.innerText(), /₹7,400\.00/);
  assert.match(await table.getByRole('row').filter({ hasText: small.number }).innerText(), /No receipt/);
  await owner.getByText('Claims without a receipt').waitFor();
  await owner.getByRole('button', { name: `Ask for the receipt on ${big.number}` }).click();
  await owner.getByRole('dialog').getByLabel('Note to the claimant').fill('The boarding pass and the airline invoice, please.');
  await owner.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
  await owner.getByRole('dialog').waitFor({ state: 'detached' });
  await row.getByText(/by Meera Finance/).waitFor();
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/missing-receipts.png`, fullPage: true });

  // The claimant sees the request on the approved claim and attaches the receipt.
  await employee.goto(`${base}/expenses/${big.id}`);
  const requests = employee.getByRole('region', { name: 'Receipt requests' });
  await requests.getByText('The boarding pass and the airline invoice, please.').waitFor();
  await requests.getByText('Finance asked for the receipt. Attach a photo or PDF of it below.').waitFor();
  if (SHOTS) await employee.screenshot({ path: `${SHOTS}/receipt-request-on-claim.png`, fullPage: true });
  await employee.getByLabel('Attach files').setInputFiles({ name: 'airline-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic airline invoice 3381\n%%EOF\n') });
  await requests.getByText('Receipt attached').waitFor();

  await owner.reload();
  await table.getByRole('row').filter({ hasText: small.number }).waitFor();
  assert.equal(await table.getByRole('row').filter({ hasText: big.number }).count(), 0);
  assert.deepEqual(consoleErrors, []);
  // Employees cannot read the list.
  assert.equal((await call(employee, `${B}/expense-claims-missing-receipts`)).status, 403);
});
