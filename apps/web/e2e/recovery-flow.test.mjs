/**
 * Browser end-to-end test for the financial recovery planner: an owner whose books show cash
 * running out sees the options worked out from overdue invoices, a supplier's bills and cost
 * lines, starts a plan, adds options, assigns an owner and a due date, watches the liquidity
 * forecast close the gap, drops an action, starts the plan and opens it as a twin scenario.
 * Nothing is posted. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, orgId, base, accounts;
const consoleErrors = [];
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  const y = +month.slice(0, 4) + Math.floor(m / 12);
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => browser?.close());

test('an owner builds a recovery plan from options worked out from the books', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Rhea Recovery');
  await page.getByLabel('Email').fill(`e2e-recovery-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Recovery Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const now = new Date().toISOString().slice(0, 7);
  const last = shift(now, -1);
  const have = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const m of [last, now]) {
    const fy = +m.slice(0, 4) + (+m.slice(5, 7) >= 4 ? 1 : 0);
    if (!have.has(fy)) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fy })).status, 201), have.add(fy);
  }
  const contact = async (name, kind) => (await call(`${base}/contacts`, { name, [kind]: true })).body.id;
  const acme = await contact('Acme Retail', 'isCustomer');
  const parts = await contact('Granite Parts', 'isVendor');
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: acme, issueDate: `${last}-01`, dueDate: `${last}-10`, post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: '300000.00' }] })).status, 201);
  assert.equal((await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: parts, issueDate: `${last}-05`, reference: 'GP-1', post: true, lines: [{ accountId: accounts['5000'], quantity: '1', unitPrice: '120000.00' }] })).status, 201);
  const post = async (debit, credit, amount, memo) =>
    assert.equal((await call(`${base}/journals`, { date: `${last}-15`, post: true, memo, lines: [{ accountId: accounts[debit], debit: amount }, { accountId: accounts[credit], credit: amount }] })).status, 201);
  await post('1120', '3100', '500000.00', 'Capital');
  await post('6100', '1120', '300000.00', 'Salaries');
  await post('6200', '1120', '30000.00', 'Rent');
  await post('6500', '1120', '20000.00', 'Marketing');
  const journals = (await call(`${base}/journals?limit=100`)).body;
  const journalCount = (Array.isArray(journals) ? journals : journals.items).length;

  await page.getByRole('link', { name: 'Recovery planner', exact: true }).click();
  await page.getByLabel('Baseline').selectOption('3');
  await page.getByText(/With no action, cash runs out in/).waitFor();
  const collect = page.getByRole('listitem', { name: 'Chase overdue invoices' });
  await collect.getByText('Who to talk to (1)').click();
  await collect.getByRole('list', { name: 'Who to talk to' }).getByText('Acme Retail').waitFor();
  await page.getByRole('listitem', { name: 'Cut Rent by 20%' }).waitFor();
  await page.getByRole('listitem', { name: 'Reduce payroll costs by 10%' }).getByText('Needs a decision').waitFor();

  // Start a plan and add options to it.
  await page.getByLabel('New plan name').fill('Q4 cash recovery');
  await page.getByRole('button', { name: 'Start a plan' }).click();
  await page.getByRole('heading', { name: 'Q4 cash recovery' }).waitFor();
  const available = (title) => page.getByRole('listitem', { name: title });
  for (const t of ['Chase overdue invoices', 'Cut Marketing by 20%', 'Ask suppliers for longer payment terms']) {
    await available(t).getByRole('button', { name: 'Add to plan' }).click();
    await page.getByRole('list', { name: 'Plan actions' }).getByRole('listitem', { name: t }).waitFor();
  }
  const loanTitle = await page.getByRole('listitem').filter({ hasText: 'Arrange a working capital loan' }).first().getAttribute('aria-label');
  await available(loanTitle).getByRole('button', { name: 'Add to plan' }).click();
  const plan = page.getByRole('list', { name: 'Plan actions' });
  await plan.getByRole('listitem', { name: loanTitle }).waitFor();
  await page.getByText('The plan closes the gap').waitFor();
  await page.getByText('Lasts all 12 months').waitFor();

  // Owner, due date and progress on the loan.
  const loan = plan.getByRole('listitem', { name: loanTitle });
  await loan.getByLabel('Owner').selectOption({ label: 'Rhea Recovery' });
  await loan.getByLabel('Due').fill('2026-12-15');
  await loan.getByLabel('Status').selectOption('IN_PROGRESS');
  await loan.getByLabel('Note').fill('Meeting the bank on Friday');
  await loan.getByRole('button', { name: 'Save note' }).click();
  // The four edits are sent one after another without waiting; none may undo another.
  await loan.getByRole('button', { name: 'Save note' }).waitFor({ state: 'attached' });
  let d, saved;
  for (let i = 0; i < 40; i++) {
    d = (await call(`${base}/recovery/plans/${page.url().split('/').pop()}`)).body;
    saved = d.actions.find((a) => a.optionKey === 'BRIDGE_LOAN');
    if (saved.note && saved.dueDate && saved.ownerId && saved.status === 'IN_PROGRESS') break;
    await page.waitForTimeout(250);
  }
  assert.equal(saved.status, 'IN_PROGRESS');
  assert.equal(saved.dueDate, '2026-12-15');
  assert.equal(saved.note, 'Meeting the bank on Friday');
  assert.equal(d.owners[saved.ownerId], 'Rhea Recovery');

  // Dropping the loan reopens the gap.
  await loan.getByLabel('Status').selectOption('DROPPED');
  await page.getByText(/^Was .* with no action$/).waitFor();

  // Start the plan, then open it as a twin scenario for the war room.
  await page.getByRole('button', { name: 'Start the plan' }).click();
  await page.getByLabel('Plan status').getByText('Active', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open as a twin scenario' }).click();
  await page.waitForURL(/\/planning\/twin\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Recovery: Q4 cash recovery' }).waitFor();
  await page.getByRole('listitem', { name: 'Change 1: Payment terms' }).waitFor();

  const after = (await call(`${base}/journals?limit=100`)).body;
  assert.equal((Array.isArray(after) ? after : after.items).length, journalCount);
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
