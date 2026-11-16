/**
 * Browser end-to-end test for AI reconciliation: an owner imports a statement, asks the AI
 * for suggestions on the unmatched lines, accepts a receipt it suggests against an open
 * invoice, dismisses an entry it suggests, and finds both in the AI activity log. Real
 * Next.js app → real API → real PostgreSQL → the real Anthropic SDK against a local stand-in
 * for the Messages API (port 4555). The API must run with ANTHROPIC_API_KEY set and
 * ANTHROPIC_BASE_URL=http://127.0.0.1:4555. Nothing reaches Anthropic.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const STAND_IN_PORT = +(process.env.ANTHROPIC_STAND_IN_PORT ?? 4555);
let browser, page, standIn;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

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
  standIn = await startAnthropicStandIn(STAND_IN_PORT);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await standIn?.close();
});

test('an owner accepts an AI receipt suggestion, dismisses an entry suggestion, and sees both in the AI log', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Bank AI Owner');
  await page.getByLabel('Email').fill(`e2e-bank-ai-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Reconcilers Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const bank = accounts['1120'];
  const customer = (await call(`${base}/contacts`, { name: 'Marigold Stores', isCustomer: true })).body;
  const inv = (await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: addDays(T, -20), dueDate: addDays(T, -5), post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: '36500.00' }] })).body;
  const csv = ['Date,Narration,Ref,Amount', `${dmy(addDays(T, -3))},NEFT CR MARIGOLD STORES,UTR9,36500.00`, `${dmy(addDays(T, -2))},GST ON CHARGES,,-118.00`].join('\n');
  assert.equal((await call(`${base}/banking/accounts/${bank}/imports`, { fileName: 'oct.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } })).status, 201);
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);

  standIn.script.push(
    (body) => {
      const t = body.messages[0].content[0].text;
      assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_suggestion' });
      const doc = new RegExp(`- (D\\d+): ${inv.number}`).exec(t)[1];
      const contact = /Marigold Stores \((C\d+)\)/.exec(t)[1];
      return { content: [{ type: 'tool_use', id: 'toolu_b1', name: 'submit_suggestion', input: { action: 'PAYMENT', contactRef: contact, allocations: [{ documentRef: doc, amount: '36500.00' }], confidence: 'HIGH', reason: `The text names Marigold Stores and the amount settles ${inv.number} exactly.` } }], stop_reason: 'tool_use', inputTokens: 1420, outputTokens: 96 };
    },
    () => ({ content: [{ type: 'tool_use', id: 'toolu_b2', name: 'submit_suggestion', input: { action: 'ENTRY', accountCode: '6900', entryDescription: 'GST on bank charges', confidence: 'MEDIUM', reason: 'Looks like GST the bank charged on its fees.' } }], stop_reason: 'tool_use' }),
  );

  await page.getByRole('link', { name: 'Bank accounts', exact: true }).click();
  await page.getByRole('link', { name: /1120/ }).first().click();
  await page.getByRole('button', { name: 'AI suggestions' }).click();
  await page.getByRole('heading', { name: 'AI suggestions', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Suggest for unmatched lines' }).click();

  const receipt = page.getByLabel('NEFT CR MARIGOLD STORES: To review');
  await receipt.waitFor();
  await receipt.getByText('Record a receipt from Marigold Stores').waitFor();
  await receipt.getByText(`${inv.number}:`).waitFor();
  await receipt.getByText('High confidence').waitFor();
  await receipt.getByText('The amounts applied add up to the bank line').waitFor();
  const charges = page.getByLabel('GST ON CHARGES: To review');
  await charges.getByText('Post to 6900 Bank Charges').waitFor();
  assert.equal((await call(`${base}/banking/accounts/${bank}/lines?status=MATCHED`)).body.lines.length, 0, 'nothing recorded before review');

  await receipt.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('tab', { name: 'Accepted' }).click();
  const accepted = page.getByLabel('NEFT CR MARIGOLD STORES: Accepted');
  await accepted.getByText(/Accepted by Bank AI Owner on .* · RCPT-000001 recorded/).waitFor();

  await page.getByRole('tab', { name: 'To review' }).click();
  await charges.getByRole('button', { name: 'Dismiss…' }).click();
  await charges.getByLabel('Why not? (optional)').fill('This is GST input credit, not a bank charge');
  await charges.getByRole('button', { name: 'Dismiss suggestion' }).click();
  await page.getByText('Nothing to review').waitFor();

  // The invoice is paid, and the bank line is matched to the receipt.
  const docAfter = (await call(`${base}/sales/documents/${inv.id}`)).body;
  assert.equal(docAfter.amountDue, '0.00');
  const matched = (await call(`${base}/banking/accounts/${bank}/lines?status=MATCHED`)).body.lines;
  assert.equal(matched.length, 1);
  assert.equal(matched[0].matches[0].payment.number, 'RCPT-000001');

  await page.getByRole('link', { name: 'AI activity', exact: true }).click();
  await page.getByRole('heading', { name: 'AI activity', exact: true }).waitFor();
  const row = page.getByRole('row', { name: /Suggested a receipt or payment for "NEFT CR MARIGOLD STORES" \(high confidence\)/ });
  await row.getByText('Accepted by Bank AI Owner').waitFor();
  await row.getByText('1,420 / 96').waitFor();
  await page.getByRole('row', { name: /Suggested an entry for "GST ON CHARGES"/ }).getByText('Dismissed by Bank AI Owner').waitFor();
  await row.getByRole('link').click();
  await page.getByLabel('NEFT CR MARIGOLD STORES: Accepted').waitFor();

  assert.deepEqual(consoleErrors, []);
});
