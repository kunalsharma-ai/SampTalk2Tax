/**
 * Browser end-to-end test for expense reconciliation (EXP-016): an employee's claims approved,
 * paid back and voided on earlier dates, and a bank statement with one of the payments matched.
 * Expense reconciliation shows the books agreeing with the claims owed, the ageing by employee,
 * and each payment against the statement; an earlier date reconciles what was owed then.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  employee = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, employee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('employee claims are reconciled to the books and the bank', async () => {
  await register(owner, 'Reema Reconciler', `e2e-exprecon-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Expense Recon Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const email = `e2e-exprecon-emp-${randomUUID()}@example.test`;
  await register(employee, 'Vikram Field', email);
  await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));
  const claim = async (title, amount, on) => {
    const c = await must(call(employee, `${B}/expense-claims`, { title, lines: [{ date: d(on + 1), accountId: acc['6600'], merchant: 'Synthetic Travels', amount }] }));
    await must(call(employee, `${B}/expense-claims/${c.id}/submit`, {}));
    return must(call(owner, `${B}/expense-claims/${c.id}/approve`, { date: d(on) }));
  };
  const pune = await claim('Pune client visit', '1200.00', 45);
  const local = await claim('Local travel', '800.00', 10);
  const delhi = await claim('Delhi trade fair', '500.00', 20);
  const fuel = await claim('Fuel', '300.00', 15);
  const paid = {};
  for (const [c, on] of [[delhi, 12], [fuel, 8]]) paid[c.id] = await must(call(owner, `${B}/expense-claims/${c.id}/reimburse`, { bankAccountId: acc['1120'], date: d(on) }));
  const csv = ['Date,Narration,Ref,Amount', `${dmy(d(12))},NEFT DR VIKRAM FIELD,UTR1,-500.00`, `${dmy(d(3))},SMS CHARGES,,-59.00`].join('\n');
  await must(call(owner, `${B}/banking/accounts/${acc['1120']}/imports`, { fileName: 'hdfc.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }));
  const lines = (await must(call(owner, `${B}/banking/accounts/${acc['1120']}/lines`))).lines;
  const je = await must(call(owner, `${B}/journals/${paid[delhi.id].reimbursementJournalEntryId}`));
  await must(call(owner, `${B}/banking/lines/${lines.find((l) => l.amount === '-500.00').id}/match`, { journalLineIds: [je.lines.find((l) => l.accountId === acc['1120']).id] }));
  consoleErrors.length = 0;

  await owner.goto(`${base}/expenses/reconciliation`);
  await owner.getByText('The account shows').waitFor();
  assert.match(await owner.getByText('The account shows').innerText(), /₹2,000\.00, exactly what the claims say is owed/);
  const owed = await owner.getByRole('table', { name: 'Claims still owed' }).locator('tbody tr').allInnerTexts();
  assert.equal(owed.length, 2);
  assert.match(owed[0], new RegExp(`${pune.number}\\s+Vikram Field\\s+Pune client visit[\\s\\S]*45\\s+₹1,200\\.00`));
  assert.match(owed[1], new RegExp(`${local.number}[\\s\\S]*10\\s+₹800\\.00`));
  const people = await owner.getByRole('table', { name: 'Owed by employee' }).locator('tbody tr').allInnerTexts();
  assert.match(people[0], /Vikram Field\s+2\s+₹2,000\.00\s+₹1,200\.00\s+45 days/);
  const bank = await owner.getByRole('table', { name: 'Reimbursements and the bank' }).locator('tbody tr').allInnerTexts();
  assert.match(bank[0], new RegExp(`${fuel.number}[\\s\\S]*₹300\\.00\\s+Not on the statement`));
  assert.match(bank[1], new RegExp(`${delhi.number}[\\s\\S]*₹500\\.00\\s+Matched on the statement`));
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/expense-reconciliation.png`, fullPage: true });

  // Twenty days ago only the Pune and Delhi claims were owed.
  await owner.getByLabel('As of').fill(d(20));
  await owner.getByRole('button', { name: 'Reconcile' }).click();
  await owner.getByText('₹1,700.00, exactly what the claims say is owed', { exact: false }).waitFor();
  const then = await owner.getByRole('table', { name: 'Claims still owed' }).locator('tbody tr').allInnerTexts();
  assert.deepEqual(then.map((t) => t.split(/\s+/)[0]), [pune.number, delhi.number]);
  assert.deepEqual(consoleErrors, []);
});
