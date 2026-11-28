/**
 * Browser end-to-end test for AP-036: the assistant may prepare payments but never execute them.
 * An owner asks the copilot to pay a vendor's bills; the "model" lists the bills and proposes a
 * draft batch; the owner confirms on the card (a sensitive action asks twice); the batch opens as a
 * draft marked as prepared with the assistant, the owner is told someone else must approve it, and
 * the server refuses the owner's approval; an approver then approves it.
 * Real Next.js app → real API → real MongoDB → the real Anthropic SDK talking to a local stand-in
 * for the Messages API (see copilot-flow.test.mjs).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const STAND_IN_PORT = +(process.env.ANTHROPIC_STAND_IN_PORT ?? 4555);
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, d) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
let browser, owner, approver, standIn;
const consoleErrors = [];

async function call(page, path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
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
  standIn = await startAnthropicStandIn(STAND_IN_PORT);
  browser = await chromium.launch();
  owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  approver = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, approver]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await standIn?.close();
});

test('the assistant prepares a draft batch that someone else must approve', async () => {
  await register(owner, 'Pallavi Payables', `e2e-aipay-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Assistant Payments Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const email = `e2e-aipay-approver-${randomUUID()}@example.test`;
  await register(approver, 'Arjun Approver', email);
  await must(call(owner, `${B}/members`, { email, role: 'APPROVER' }));
  await must(call(owner, `${B}/copilot/settings`, { enabled: true }, 'PUT'));
  const vendor = await must(call(owner, `${B}/contacts`, { name: 'Paper Mart', isVendor: true }));
  await must(call(owner, `${B}/contacts/${vendor.id}/bank-details`, { accountName: 'Paper Mart', accountNumber: '123456789012', ifsc: 'HDFC0000001' }, 'PUT'));
  await must(call(approver, `${B}/contacts/${vendor.id}/bank-details/verify`, { note: 'Checked the cancelled cheque' }));
  const bills = [];
  for (const [i, price] of [[1, '2400.00'], [2, '1800.00']]) bills.push(await must(call(owner, `${B}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: addDays(T, -20), dueDate: addDays(T, i), reference: `PM-${i}`, post: true, lines: [{ accountId: acc['6600'], quantity: '1', unitPrice: price }] })));
  consoleErrors.length = 0;

  await owner.goto(`${WEB}/orgs/${orgId}/copilot`);
  // Only the copilot's own requests (which offer it the payment tools) use up the script; a
  // background runner calling the model for another organisation gets an error instead.
  standIn.accept = (body) => Array.isArray(body.tools) && body.tools.some((t) => t.name === 'propose_payment_batch');
  standIn.script.push(
    () => ({ content: [{ type: 'tool_use', id: 'toolu_p1', name: 'list_payable_bills', input: {} }], stop_reason: 'tool_use' }),
    (body) => {
      const r = JSON.parse(body.messages.at(-1).content[0].content);
      assert.deepEqual(r.bills.map((b) => b.amount_due), ['2400.00', '1800.00']);
      return { content: [{ type: 'tool_use', id: 'toolu_p2', name: 'propose_payment_batch', input: { bank_account_ref: r.bank_accounts.find((a) => a.code === '1120').bank_account_ref, payment_date: addDays(T, 1), bill_refs: r.bills.map((b) => b.bill_ref) } }], stop_reason: 'tool_use' };
    },
    () => ({ content: [{ type: 'text', text: 'I have proposed a **draft** payment batch for both Paper Mart bills. Confirm it on the card; an approver must still approve it before anything is paid.' }], stop_reason: 'end_turn' }),
  );
  await owner.getByLabel('Your question').fill('Prepare payment of the Paper Mart bills for tomorrow');
  await owner.getByRole('button', { name: 'Ask', exact: true }).click();
  const card = owner.getByRole('group', { name: 'Proposed action' });
  await card.getByText(/^Prepare a draft payment batch from .+, dated .+, paying 2 bills for INR 4200\.00/).waitFor();
  await card.getByText('Sensitive').waitFor();
  assert.equal((await call(owner, `${B}/purchases/payment-batches`)).body.batches.length, 0);
  await owner.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/assistant-payment-proposal.png`, fullPage: true });
  await card.getByRole('button', { name: 'Confirm' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Yes, do it' }).click();
  await card.getByText('Done').waitFor();
  await card.getByRole('link', { name: 'Payment batch PB-0001 (draft, waiting for approval)' }).click();
  await owner.waitForURL(/\/purchases\/payment-batches\/[0-9a-f-]{36}$/);
  const batchUrl = owner.url();
  await owner.getByText('You accepted this batch from the assistant, so someone else with approval rights must approve it.', { exact: false }).waitFor();
  await owner.getByText('With the assistant', { exact: true }).waitFor();
  await owner.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/assistant-payment-batch.png`, fullPage: true });
  await owner.getByRole('button', { name: 'Approve' }).click();
  await owner.getByText('This batch was prepared with the assistant, so someone other than the member who accepted it must approve it').waitFor();
  await approver.goto(batchUrl);
  await approver.getByText('The assistant prepared this batch and a member accepted it.', { exact: false }).waitFor();
  await approver.getByRole('button', { name: 'Approve' }).click();
  await approver.getByText(/^Arjun Approver · /).waitFor();
  assert.equal((await call(approver, `${B}/purchases/payment-batches/${batchUrl.split('/').pop()}`)).body.status, 'APPROVED');
  // The refused approval logs its 409 response; nothing else may error.
  assert.deepEqual(consoleErrors.filter((e) => !/409/.test(e)), []);
});
