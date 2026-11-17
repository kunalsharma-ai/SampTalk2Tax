/**
 * Browser end-to-end test for supplier payment batches and vendor bank-detail checks: an owner
 * enters a vendor's bank details, a second person (an approver) verifies them; the owner prepares
 * a batch of two bills (one paid in part), which is blocked while the other vendor has no verified
 * details; the approver approves it, the owner downloads the bank file and records the payments,
 * and each bill links to its payment. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, owner, approver, orgId;
const consoleErrors = [];
const approverEmail = `e2e-pb-approver-${randomUUID()}@example.test`;

async function call(p, path, body, method = body ? 'POST' : 'GET') {
  return p.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

async function register(p, name, email) {
  await p.goto(`${WEB}/register`);
  await p.getByLabel('Full name').fill(name);
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill('e2e-very-long-password');
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.waitForURL(/\/onboarding|\/orgs/);
}

before(async () => {
  browser = await chromium.launch();
  owner = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  approver = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, approver]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a batch is prepared, approved by someone else, sent to the bank and recorded', async () => {
  await register(owner, 'Batch Owner', `e2e-pb-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Payment Batches Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = owner.url().split('/orgs/')[1];
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(owner, `${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = async (name) => (await call(owner, `${base}/contacts`, { name, isVendor: true, paymentTermsDays: 15 })).body;
  const cedar = await vendor('Cedar Hardware');
  const granite = await vendor('Granite Supplies');
  const bill = async (contactId, price, reference) => {
    const r = await call(owner, `${base}/purchases/documents`, { kind: 'BILL', contactId, issueDate: T, reference, post: true, lines: [{ accountId: acc['6600'], quantity: '1', unitPrice: price }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const c1 = await bill(cedar.id, '11800.00', 'CH-101');
  const g1 = await bill(granite.id, '20000.00', 'GS-7');

  await register(approver, 'Second Approver', approverEmail);
  assert.equal((await call(owner, `${base}/members`, { email: approverEmail, role: 'APPROVER' })).status, 201);

  // Cedar's bank details, entered by the owner.
  await owner.goto(`${WEB}/orgs/${orgId}/purchases/vendors/${cedar.id}`);
  await owner.getByRole('button', { name: 'Add bank details' }).click();
  const add = owner.getByRole('dialog', { name: 'Add bank details' });
  await add.getByLabel('Account holder name').fill('Cedar Hardware LLP');
  await add.getByLabel('Account number').fill('5010 0123 4567');
  await add.getByLabel('IFSC').fill('hdfc0001234');
  await add.getByLabel('Bank and branch (optional)').fill('HDFC Bank, Fort');
  await add.getByRole('button', { name: 'Save bank details' }).click();
  await add.waitFor({ state: 'detached' });
  await owner.getByText('XXXXXXXX4567').first().waitFor();
  await owner.getByText('Not verified').first().waitFor();
  // The owner changed them; someone else is there to verify, so the owner cannot.
  const selfVerify = await call(owner, `${base}/contacts/${cedar.id}/bank-details/verify`, { note: 'Checked it myself' });
  assert.equal(selfVerify.status, 409);
  assert.equal(selfVerify.body.error, 'SAME_PERSON');

  // The approver verifies them.
  await approver.goto(`${WEB}/orgs/${orgId}/purchases/vendors/${cedar.id}`);
  await approver.getByRole('button', { name: 'Verify…' }).click();
  const verify = approver.getByRole('dialog', { name: 'Verify bank details' });
  await verify.getByLabel('How were they confirmed?').fill('Called their accounts head on the number in our records');
  await verify.getByRole('button', { name: 'Mark verified' }).click();
  await verify.waitFor({ state: 'detached' });
  await approver.getByText(/By Second Approver on/).first().waitFor();

  // The owner prepares a batch: all of Cedar's bill, part of Granite's.
  await owner.goto(`${WEB}/orgs/${orgId}/purchases/payment-batches`);
  await owner.getByRole('heading', { name: 'Payment batches' }).waitFor();
  await owner.getByRole('link', { name: 'New batch' }).click();
  await owner.waitForURL(/payment-batches\/new$/);
  const bills = owner.getByRole('table', { name: 'Bills to pay' });
  await bills.getByRole('row', { name: new RegExp(c1.number) }).getByText(/Verified 4567/).waitFor();
  await bills.getByRole('row', { name: new RegExp(g1.number) }).getByText('None').waitFor();
  await owner.getByLabel(`Pay ${c1.number}`).check();
  await owner.getByLabel(`Pay ${g1.number}`).check();
  assert.equal(await owner.getByLabel(`Amount for ${g1.number}`).inputValue(), '20000.00');
  await owner.getByLabel(`Amount for ${g1.number}`).fill('5000');
  await owner.getByLabel('Note (optional)').fill('Friday supplier run');
  await owner.getByRole('button', { name: 'Save batch' }).click();
  await owner.waitForURL(/payment-batches\/[0-9a-f-]{36}$/);
  await owner.getByRole('heading', { name: 'Payment batch PB-0001' }).waitFor();
  await owner.getByText('Granite Supplies has no bank details').waitFor();

  // Granite has no details yet, so the approver cannot approve.
  const batchUrl = owner.url();
  await approver.goto(batchUrl);
  await approver.getByRole('heading', { name: 'Payment batch PB-0001' }).waitFor();
  assert.equal(await approver.getByRole('button', { name: 'Approve' }).isDisabled(), true);

  // Take Granite out and pay only Cedar this time.
  await owner.getByRole('link', { name: 'Edit' }).click();
  await owner.waitForURL(/\/edit$/);
  await owner.getByLabel(`Pay ${g1.number}`).uncheck();
  await owner.getByRole('button', { name: 'Save changes' }).click();
  await owner.waitForURL(/payment-batches\/[0-9a-f-]{36}$/);
  await owner.getByRole('table', { name: 'Vendors in this batch' }).getByRole('row', { name: /Cedar Hardware.*XXXXXXXX4567.*Verified.*11,800\.00/ }).waitFor();
  assert.equal(await owner.getByText('This batch cannot go ahead yet').count(), 0);
  // The owner prepared it; the approver is there, so the owner cannot approve it.
  const selfApprove = await call(owner, `${base}/purchases/payment-batches/${batchUrl.split('/').pop()}/approve`, {});
  assert.equal(selfApprove.status, 409);

  // The approver approves it.
  await approver.reload();
  await approver.getByRole('button', { name: 'Approve' }).click();
  await approver.getByText('Approved', { exact: true }).first().waitFor();
  await approver.getByText(/Second Approver ·/).waitFor();
  assert.equal(await approver.getByRole('button', { name: 'Download bank file' }).count(), 0);

  // The owner downloads the bank file.
  await owner.reload();
  const [download] = await Promise.all([owner.waitForEvent('download'), owner.getByRole('button', { name: 'Download bank file' }).click()]);
  assert.match(download.suggestedFilename(), /PB-0001.*\.csv$/);
  const csv = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  assert.match(csv, /^Payment date,Debit account,Beneficiary name,Beneficiary account number,IFSC,Amount/);
  assert.match(csv, new RegExp(`Cedar Hardware LLP,501001234567,HDFC0001234,11800\\.00,INR,PB-0001 ${c1.number},`));
  await owner.getByText(/Downloaded .*PB-0001/).waitFor();

  // And records the payments once the bank has paid.
  await owner.getByRole('button', { name: 'Record payments' }).click();
  const pay = owner.getByRole('dialog', { name: 'Record the payments of PB-0001' });
  await pay.getByRole('button', { name: 'Record 1 payment' }).click();
  await pay.waitFor({ state: 'detached' });
  await owner.getByText('Paid', { exact: true }).first().waitFor();
  const row = owner.getByRole('table', { name: 'Bills in this batch' }).getByRole('row', { name: new RegExp(c1.number) });
  const payLink = row.getByRole('link').nth(1);
  await payLink.waitFor();
  assert.match(await payLink.getAttribute('href'), /purchases\/payments\/[0-9a-f-]{36}$/);
  assert.equal((await call(owner, `${base}/purchases/documents/${c1.id}`)).body.amountDue, '0.00');
  assert.equal((await call(owner, `${base}/purchases/documents/${g1.id}`)).body.amountDue, '20000.00');

  // The list shows it paid.
  await owner.getByRole('link', { name: 'Payment batches' }).first().click();
  await owner.getByRole('table', { name: 'Payment batches' }).getByRole('row', { name: /PB-0001.*Paid/ }).waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
