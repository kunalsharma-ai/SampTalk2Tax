/**
 * Browser end-to-end test for automated audit evidence on expense claims (EXP-027): an employee's
 * claim with a receipt file, still unpaid, and one without a receipt whose payment is missing from
 * an imported bank statement. Expense audit evidence shows the first complete and the second with
 * two gaps, filters to gaps, opens the evidence pack with the file checksum and the audit trail,
 * and downloads the CSV index. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const d = (n) => new Date(Date.parse(`${T}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
let browser, owner, employee;
const consoleErrors = [];

async function call(page, path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
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
  owner = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  employee = await (await browser.newContext()).newPage();
  for (const p of [owner, employee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('expense audit evidence shows what each claim has and what is missing', async () => {
  await register(owner, 'Esha Evidence', `e2e-evidence-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Evidence Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const email = `e2e-evidence-emp-${randomUUID()}@example.test`;
  await register(employee, 'Vikram Field', email);
  await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));
  const claim = async (title, amount, on, receipt) => {
    const c = await must(call(employee, `${B}/expense-claims`, { title, lines: [{ date: d(on + 1), accountId: acc['6600'], merchant: 'Synthetic Travels', amount }] }));
    if (receipt) {
      const r = await employee.evaluate(async (u) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t2t-csrf': '1' }, body: new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n') })).status, `/api/t2t${B}/attachments?entityType=EXPENSE_CLAIM&entityId=${c.id}&fileName=taxi-receipt.pdf`);
      assert.equal(r, 201);
    }
    await must(call(employee, `${B}/expense-claims/${c.id}/submit`, {}));
    return must(call(owner, `${B}/expense-claims/${c.id}/approve`, { date: d(on) }));
  };
  const taxi = await claim('Airport taxi', '1200.00', 12, true);
  const lunch = await claim('Team lunch', '800.00', 10, false);
  await must(call(owner, `${B}/expense-claims/${lunch.id}/reimburse`, { bankAccountId: acc['1120'], date: d(8) }));
  const csv = ['Date,Narration,Ref,Amount', `${dmy(d(2))},SMS CHARGES,,-59.00`].join('\n');
  await must(call(owner, `${B}/banking/accounts/${acc['1120']}/imports`, { fileName: 'hdfc.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }));
  consoleErrors.length = 0;

  await owner.goto(`${base}/expenses/evidence`);
  const table = owner.getByRole('table', { name: 'Evidence by claim' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText(), new RegExp(`${taxi.number}[\\s\\S]*Approved[\\s\\S]*Vikram Field[\\s\\S]*₹1,200\\.00\\s+OK\\s+OK\\s+OK\\s+OK\\s+Pending\\s+n/a\\s+OK`));
  assert.match(await rows.nth(1).innerText(), new RegExp(`${lunch.number}[\\s\\S]*Reimbursed[\\s\\S]*₹800\\.00\\s+Gap\\s+OK\\s+OK\\s+OK\\s+OK\\s+Gap\\s+OK`));
  assert.match(await owner.locator('main').innerText(), /With gaps\s+1\s+Receipts 1, Bank statement 1/i);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/expense-evidence.png`, fullPage: true });

  await owner.getByLabel('Only claims with gaps').check();
  await rows.first().getByText(lunch.number).waitFor();
  assert.equal(await rows.count(), 1);

  const download = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'Download evidence index (CSV)' }).click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^expense-evidence-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile(await file.path(), 'utf8');
  assert.match(text, new RegExp(`${lunch.number},Vikram Field,REIMBURSED,800\\.00,Receipts,GAP,No receipt is attached to the claim`));
  assert.match(text, new RegExp(`${taxi.number},Vikram Field,APPROVED,1200\\.00,Receipt file,OK,,taxi-receipt\\.pdf,[0-9a-f]{64}`));

  await owner.getByLabel('Only claims with gaps').uncheck();
  await rows.nth(1).waitFor();
  await rows.getByRole('link', { name: taxi.number }).click();
  await owner.waitForURL(new RegExp(`/expenses/evidence/${taxi.id}`));
  await owner.getByRole('table', { name: 'Evidence collected' }).waitFor();
  const items = await owner.getByRole('table', { name: 'Evidence collected' }).locator('tbody tr').allInnerTexts();
  assert.equal(items.length, 7);
  assert.match(items[1], /Approval\s+OK\s+Approved by Esha Evidence at/);
  assert.match(items[4], /Reimbursement\s+Pending\s+Approved, not reimbursed yet/);
  assert.match(await owner.getByRole('table', { name: 'Receipt files and checksums' }).innerText(), /taxi-receipt\.pdf[\s\S]*[0-9a-f]{64}/);
  const trail = await owner.getByRole('table', { name: 'Claim audit trail' }).locator('tbody tr').allInnerTexts();
  assert.deepEqual(trail.map((t) => t.split('\t')[0].trim()), ['Created', 'Submitted', 'Approved']);
  assert.match(trail[2], /Approved\s+Esha Evidence/);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/expense-evidence-pack.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
