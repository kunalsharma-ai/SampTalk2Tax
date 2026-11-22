/**
 * Browser end-to-end test for contract-to-invoice matching (AR-041): a customer on a quarterly
 * contract billed in arrears is invoiced by hand; the page matches the invoice to the contract's
 * next period and counting it as that period takes it off the list. A second invoice for the
 * same period at a lower price is flagged as billed twice with the price difference, and is
 * dismissed with a reason. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const first = `${T.slice(0, 7)}-01`;
let browser, owner;
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
  owner.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('hand-made invoices are matched to the contract they bill', async () => {
  await register(owner, 'Rhea Matching', `e2e-ctmatch-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Contract Matching Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = await must(call(owner, `${B}/contacts`, { name: 'Synthetic Juniper Clinics', isCustomer: true }));
  const draft = await must(call(owner, `${B}/sales/contracts`, {
    contactId: customer.id, title: 'Clinic software', frequency: 'QUARTERLY', timing: 'ARREARS', startDate: first, endDate: null, autoRenew: false, noticeDays: 30,
    lines: [{ accountId: acc['4100'], description: 'Clinic software licences', quantity: '5', unitPrice: '3000.00' }, { accountId: acc['4100'], description: 'Priority support', quantity: '1', unitPrice: '5000.00' }],
  }));
  const contract = await must(call(owner, `${B}/sales/contracts/${draft.id}/activate`, {}));
  const invoice = (lic) => must(call(owner, `${B}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, post: true, lines: [{ accountId: acc['4100'], description: 'Licences for clinic software', quantity: '5', unitPrice: lic }, { accountId: acc['4100'], description: 'Priority support', quantity: '1', unitPrice: '5000.00' }] }));
  const one = await invoice('3000.00');

  await owner.goto(`${base}/sales/contract-matching`);
  await owner.getByRole('heading', { name: 'Contract matching' }).waitFor();
  const table = owner.getByRole('table', { name: 'Invoices matched to contracts' });
  const row = table.getByRole('row').filter({ hasText: one.number });
  await row.getByText('Next period').waitFor();
  assert.match(await row.innerText(), new RegExp(`${contract.number ?? 'CT-0001'}[\\s\\S]*Strong match · 100[\\s\\S]*Count it as period 1`));
  await row.getByRole('button', { name: 'Count as period 1' }).click();
  await owner.getByText('No invoice to match').waitFor();
  const detail = await must(call(owner, `${B}/sales/contracts/${contract.id}`));
  assert.equal(detail.periods[0].invoice.id, one.id);

  // A second invoice for the same quarter, at a lower price.
  const two = await invoice('2600.00');
  await owner.reload();
  const twice = table.getByRole('row').filter({ hasText: two.number });
  await twice.getByText('Billed twice?').waitFor();
  const diffs = twice.getByRole('list', { name: `Price differences on ${two.number}` });
  assert.match(await diffs.innerText(), /Clinic software licences: billed 5 × [\s\S]*2,600\.00, contract 5 × [\s\S]*3,000\.00/);
  assert.match(await twice.innerText(), new RegExp(`already billed period 1 on ${one.number}`));
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/contract-matching.png`, fullPage: true });

  await twice.getByRole('button', { name: 'Not this contract' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Why').fill('Discounted re-issue agreed with the clinic; credit note to follow');
  await dialog.getByRole('button', { name: 'Dismiss match' }).click();
  await owner.getByText('No invoice to match').waitFor();
  await owner.getByText('1 match dismissed').waitFor();

  assert.deepEqual(consoleErrors, []);
});
