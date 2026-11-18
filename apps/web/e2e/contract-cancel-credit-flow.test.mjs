/**
 * Browser end-to-end test for AR-011: an owner cancels a monthly contract part-way through a
 * period already billed in advance on a posted invoice, sees the unused days and their credit in
 * the cancel dialog, cancels, and finds the draft credit note for exactly that amount.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const lastMonth = (() => {
  const [y, m, d] = T.split('-').map(Number);
  const total = y * 12 + (m - 1) - 1;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
})();
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

test('cancelling part-way through a billed month credits the unused days', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Cancel Credit Owner');
  await page.getByLabel('Email').fill(`e2e-cancel-credit-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Cancel Credit Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const orgId = base.split('/orgs/')[1];
  const api = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${api}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${api}/contacts`, { name: 'Iyer Foods', isCustomer: true })).body;
  const draft = await call(`${api}/sales/contracts`, {
    contactId: customer.id, title: 'Managed payroll', frequency: 'MONTHLY', timing: 'ADVANCE', startDate: lastMonth, endDate: null, autoRenew: false, noticeDays: 30,
    lines: [{ accountId: acc['4100'], description: 'Payroll service', quantity: '1', unitPrice: '31000.00' }],
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const c = (await call(`${api}/sales/contracts/${draft.body.id}/activate`, {})).body;
  for (const p of c.periods) assert.equal((await call(`${api}/sales/documents/${p.invoice.id}/post`, {})).status, 200);
  const preview = (await call(`${api}/sales/contracts/${c.id}/cancel-credit`)).body;
  assert.equal(preview.periods.length, 1);

  await page.goto(`${base}/sales/contracts/${c.id}`);
  await page.getByRole('button', { name: 'Cancel contract' }).click();
  const dialog = page.getByRole('dialog');
  const table = dialog.getByRole('table', { name: 'Unused days to credit' });
  await table.waitFor();
  const p = preview.periods[0];
  await table.getByText(`${p.days} of ${p.of} days`).waitFor();
  assert.ok(await dialog.getByLabel(/Credit the unused days/).isChecked());
  await dialog.getByLabel('Why is it cancelled?').fill('Customer closed the Pune office');
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/contract-cancel-credit-dialog.png` });
  }
  await dialog.getByRole('button', { name: 'Cancel contract' }).click();
  await page.getByRole('alert').getByText('Customer closed the Pune office').waitFor();
  await page.getByText('a draft credit note for unused days').waitFor();

  const notes = (await call(`${api}/sales/documents?kind=CREDIT_NOTE&view=all`)).body;
  const list = notes.items ?? notes.documents ?? notes;
  const cn = list.find((d) => d.kind === 'CREDIT_NOTE');
  assert.ok(cn, 'a credit note was made');
  assert.equal(cn.status, 'DRAFT');
  assert.equal(cn.total, preview.total);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/contract-cancelled-with-credit.png` });

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
