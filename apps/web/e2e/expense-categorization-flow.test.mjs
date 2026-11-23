/**
 * Browser end-to-end test for automatic expense categorisation (EXP-020, AP-020) and bill coding (AP-026): an employee's
 * approved claims from one merchant, then a new claim where typing that merchant suggests the
 * account it went to before, and a merchant whose name says the kind of spending; on a bill, the
 * vendor's earlier bills suggest the account, and Code lines from history fills the account, tax
 * and department of every blank line. Nothing changes until Use or Code is pressed.
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

test('claim and bill lines suggest the account used before', async () => {
  await register(owner, 'Kiran Categories', `e2e-expcat-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Categories Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const email = `e2e-expcat-emp-${randomUUID()}@example.test`;
  await register(employee, 'Meera Field', email);
  await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));
  for (const [i, account] of [[1, '6700'], [2, '6700'], [3, '6500']]) {
    const c = await must(call(employee, `${B}/expense-claims`, { title: `Visit ${i}`, lines: [{ date: d(10 + i), accountId: acc[account], merchant: 'Synthetic Movers', description: 'Site visit', amount: '650.00' }] }));
    await must(call(employee, `${B}/expense-claims/${c.id}/submit`, {}));
    await must(call(owner, `${B}/expense-claims/${c.id}/approve`, { date: d(5) }));
  }
  const vendor = await must(call(owner, `${B}/contacts`, { name: 'Paper Mart', isVendor: true }));
  for (const reference of ['PM-1', 'PM-2']) await must(call(owner, `${B}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: d(20), reference, post: true, lines: [{ accountId: acc['6600'], description: 'A4 paper reams', quantity: '1', unitPrice: '2400.00' }] }));
  const tax18 = (await must(call(owner, `${B}/tax-rates`, { name: 'Standard 18%', rate: '18', salesAccountId: acc['2300'], purchaseAccountId: acc['1450'] }))).id;
  const fin = (await must(call(owner, `${B}/dimensions`, { type: 'DEPARTMENT', code: 'FIN', name: 'Finance' }))).id;
  const advisors = await must(call(owner, `${B}/contacts`, { name: 'Synthetic Advisors', isVendor: true }));
  for (const i of [1, 2]) await must(call(owner, `${B}/purchases/documents`, { kind: 'BILL', contactId: advisors.id, issueDate: d(30 * i), reference: `SA-${i}`, post: true, lines: [{ accountId: acc['6600'], description: 'Monthly retainer', quantity: '1', unitPrice: '25000.00', taxRateId: tax18, departmentId: fin }, { accountId: acc['6500'], description: 'Newsletter design', quantity: '1', unitPrice: '5000.00' }] }));
  consoleErrors.length = 0;

  await employee.goto(`${base}/expenses/new`);
  await employee.getByLabel('Title').fill('Site visits, Thane');
  await employee.getByLabel('Merchant for line 1').fill('Synthetic Movers');
  await employee.getByLabel('Description for line 1').fill('Site visit Thane');
  const hint1 = employee.getByRole('status', { name: 'Suggested account for line 1' });
  await hint1.waitFor();
  assert.match(await hint1.innerText(), /Suggested: 6700 · Travel \(likely\)[\s\S]*2 of 3 earlier lines from Synthetic Movers went here; "site" was on 3 earlier lines, 2 of them booked here/);
  assert.equal(await employee.getByLabel('Category for line 1').inputValue(), '');
  await employee.getByRole('button', { name: '+ Add receipt' }).click();
  await employee.getByLabel('Merchant for line 2').fill('Airtel');
  await employee.getByLabel('Description for line 2').fill('Broadband for October');
  const hint2 = employee.getByRole('status', { name: 'Suggested account for line 2' });
  await hint2.waitFor();
  assert.match(await hint2.innerText(), /6300 · Utilities \(possible\)[\s\S]*"airtel" reads as phone and internet/);
  await employee.getByLabel('Amount for line 1').fill('700');
  await employee.getByLabel('Amount for line 2').fill('1199');
  await employee.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  if (SHOTS) await employee.screenshot({ path: `${SHOTS}/expense-category-suggestion.png`, fullPage: true });
  await employee.getByRole('button', { name: 'Use the suggested account for line 1' }).click();
  await hint1.waitFor({ state: 'detached' });
  assert.equal(await employee.getByLabel('Category for line 1').inputValue(), `acc:${acc['6700']}`);
  await employee.getByRole('button', { name: 'Use the suggested account for line 2' }).click();
  assert.equal(await employee.getByLabel('Category for line 2').inputValue(), `acc:${acc['6300']}`);
  await employee.getByRole('button', { name: 'Save draft' }).click();
  await employee.waitForURL(/\/expenses\/[0-9a-f-]{36}$/);

  await owner.goto(`${base}/purchases/bills/new`);
  await owner.locator('#doc-contact option', { hasText: 'Paper Mart' }).waitFor({ state: 'attached' });
  await owner.locator('#doc-contact').selectOption({ label: 'Paper Mart' });
  await owner.getByLabel('Description for line 1').fill('A4 paper, 5 reams');
  const hint3 = owner.getByRole('status', { name: 'Suggested account for line 1' });
  await hint3.waitFor();
  assert.match(await hint3.innerText(), /6600 · Professional Fees \(likely\)[\s\S]*2 of 2 earlier lines from Paper Mart went here/);
  await owner.getByRole('button', { name: 'Use the suggested account for line 1' }).click();
  assert.equal(await owner.getByLabel('Account for line 1').inputValue(), acc['6600']);
  await hint3.waitFor({ state: 'detached' });

  // A whole bill coded from the vendor's history: blank fields only.
  await owner.goto(`${base}/purchases/bills/new`);
  await owner.locator('#doc-contact option', { hasText: 'Synthetic Advisors' }).waitFor({ state: 'attached' });
  await owner.locator('#doc-contact').selectOption({ label: 'Synthetic Advisors' });
  await owner.getByLabel('Description for line 1').fill('Retainer for November');
  await owner.getByLabel('Unit price for line 1').fill('25000');
  await owner.getByRole('button', { name: '+ Add line' }).click();
  await owner.getByLabel('Description for line 2').fill('Newsletter design');
  await owner.getByLabel('Unit price for line 2').fill('5000');
  await owner.getByRole('button', { name: 'Code lines from history' }).click();
  await owner.getByRole('status', { name: 'Bill coding' }).waitFor();
  assert.equal(await owner.getByRole('status', { name: 'Bill coding' }).innerText(), 'Filled 2 lines from the 4 lines on earlier bills from Synthetic Advisors. Check them before saving.');
  assert.equal(await owner.getByLabel('Account for line 1').inputValue(), acc['6600']);
  assert.equal(await owner.getByLabel('Tax for line 1').inputValue(), tax18);
  assert.equal(await owner.getByLabel('Department for line 1').inputValue(), fin);
  assert.equal(await owner.getByLabel('Account for line 2').inputValue(), acc['6500']);
  assert.equal(await owner.getByLabel('Tax for line 2').inputValue(), '');
  await owner.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/bill-coding.png`, fullPage: true });
  await owner.getByRole('button', { name: 'Post bill' }).click();
  await owner.waitForURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  assert.deepEqual(consoleErrors, []);
});
