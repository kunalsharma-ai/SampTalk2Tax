/**
 * Browser end-to-end test for reimbursement routing (EXP-026): two employees' approved claims,
 * one with a salary account on their employee record and one without. Reimbursement routing sends
 * the first to a bank transfer and the second to cash, a larger amount kept makes them wait, and
 * paying only the first reimburses their claims and leaves the second on the list.
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
const APR = `${Number(T.slice(0, 4)) - (T.slice(5, 7) < '04' ? 1 : 0)}-04`;
let browser, owner, vikram, priya;
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
  vikram = await (await browser.newContext()).newPage();
  priya = await (await browser.newContext()).newPage();
  for (const p of [owner, vikram, priya]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('approved claims are routed per person and the ready ones are paid', async () => {
  await register(owner, 'Rohan Router', `e2e-routing-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Routing Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const people = {};
  for (const [page, name] of [[vikram, 'Vikram Field'], [priya, 'Priya Design']]) {
    const email = `e2e-routing-${randomUUID()}@example.test`;
    await register(page, name, email);
    await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));
    people[name] = email;
  }
  const structure = { effectiveFrom: `${APR}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '30000' }] };
  await must(call(owner, `${B}/payroll/employees`, { code: 'E001', name: 'Vikram F', email: people['Vikram Field'], dateOfJoining: `${APR}-01`, structure, bankAccountName: 'Vikram F', bankAccountNumber: '5010 0012 3456 78', bankIfsc: 'HDFC0001234' }));
  const customer = await must(call(owner, `${B}/contacts`, { name: 'Funding Customer', isCustomer: true }));
  for (const [code, amount] of [['1120', '20000'], ['1110', '2000']]) await must(call(owner, `${B}/sales/payments`, { contactId: customer.id, date: d(20), bankAccountId: acc[code], amount, allocations: [] }));
  const claim = async (page, title, amount, on) => {
    const c = await must(call(page, `${B}/expense-claims`, { title, lines: [{ date: d(on + 1), accountId: acc['6600'], merchant: 'Synthetic Travels', amount }] }));
    await must(call(page, `${B}/expense-claims/${c.id}/submit`, {}));
    return must(call(owner, `${B}/expense-claims/${c.id}/approve`, { date: d(on) }));
  };
  const pune = await claim(vikram, 'Pune client visit', '3000.00', 10);
  const fuel = await claim(vikram, 'Fuel', '2000.00', 2);
  const props = await claim(priya, 'Photo shoot props', '400.00', 1);

  await owner.goto(`${base}/expenses/reimbursement-routing`);
  const table = owner.getByRole('table', { name: 'Payments by person' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText(), new RegExp(`Vikram Field[\\s\\S]*Employee: Vikram F[\\s\\S]*${pune.number}[\\s\\S]*${fuel.number}[\\s\\S]*₹5,000\\.00[\\s\\S]*10 days[\\s\\S]*Over 7 days[\\s\\S]*Bank transfer[\\s\\S]*1120 Operating Bank Account`));
  assert.match(await rows.nth(1).innerText(), new RegExp(`Priya Design[\\s\\S]*${props.number}[\\s\\S]*₹400\\.00[\\s\\S]*Pay in cash[\\s\\S]*1110 Cash on Hand[\\s\\S]*No salary account on file`));
  assert.doesNotMatch(await owner.locator('main').innerText(), /5010|3456/);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/reimbursement-routing.png`, fullPage: true });

  // Keeping 19,000 back leaves no room for either.
  await owner.getByLabel('Keep in each account').fill('19000');
  await owner.getByRole('button', { name: 'Route claims' }).click();
  await rows.nth(1).getByText('Wait for cash').waitFor();
  assert.match(await rows.nth(0).innerText(), /Wait for cash/);
  assert.equal(await owner.getByRole('button', { name: /^Pay \d+ selected$/ }).isDisabled(), true);

  await owner.getByLabel('Keep in each account').fill('0');
  await owner.getByRole('button', { name: 'Route claims' }).click();
  await rows.nth(0).getByText('Bank transfer').waitFor();
  await owner.getByLabel('Pay Priya Design').uncheck();
  await owner.getByLabel('Reference').fill('Friday run');
  await owner.getByRole('button', { name: 'Pay 1 selected' }).click();
  await owner.getByText('Paid 1 person').waitFor();
  assert.match(await owner.getByRole('status').filter({ hasText: 'Paid 1 person' }).innerText(), new RegExp(`Vikram Field: ${pune.number}, ${fuel.number} from Operating Bank Account`));
  await table.locator('tbody tr', { hasText: 'Vikram Field' }).waitFor({ state: 'detached' });
  assert.equal(await rows.count(), 1);
  const paid = await must(call(owner, `${B}/expense-claims/${pune.id}`));
  assert.equal(paid.status, 'REIMBURSED');
  assert.equal(paid.reimbursementReference, 'Friday run');
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/reimbursement-routing-paid.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
