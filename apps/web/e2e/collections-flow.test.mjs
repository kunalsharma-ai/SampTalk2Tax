/**
 * Browser end-to-end test for the AI collections agent: an owner has the AI draft payment
 * reminders for overdue customers, sees the one it could not email left out, opens a draft,
 * watches the checks against the books catch a wrong amount as it is typed, fixes it, sends
 * the reminder and finds the call in the AI activity log. Real Next.js app → real API → real
 * PostgreSQL → the real Anthropic SDK against a local stand-in for the Messages API (port
 * 4555) → nodemailer → a local SMTP server (port 4556). The API must run with
 * ANTHROPIC_API_KEY set, ANTHROPIC_BASE_URL=http://127.0.0.1:4555, SMTP_URL=smtp://127.0.0.1:4556
 * and EMAIL_FROM set. Nothing reaches Anthropic or a real mailbox.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';
import { startSmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const STAND_IN_PORT = +(process.env.ANTHROPIC_STAND_IN_PORT ?? 4555);
const SMTP_PORT = +(process.env.SMTP_STAND_IN_PORT ?? 4556);
let browser, page, standIn, smtp, orgId, base;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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
  smtp = await startSmtpStandIn(SMTP_PORT);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await standIn?.close();
  await smtp?.close();
});

test('an owner has reminders drafted, fixes a wrong amount the checks catch, sends one and finds it in the AI log', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Collections Owner');
  await page.getByLabel('Email').fill(`e2e-collections-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Collectors Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  const accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const email = `accounts-${randomUUID().slice(0, 8)}@saffron.test`;
  const saffron = (await call(`${base}/contacts`, { name: 'Saffron Foods', isCustomer: true, email })).body;
  const nomail = (await call(`${base}/contacts`, { name: 'Quiet Traders', isCustomer: true })).body;
  const inv = (await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: saffron.id, issueDate: addDays(T, -20), dueDate: addDays(T, -5), post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: '25000.00' }] })).body;
  assert.ok(inv.number);
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: nomail.id, issueDate: addDays(T, -20), dueDate: addDays(T, -2), post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: '4000.00' }] })).status, 201);
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);

  // The "model" drafts from the facts it was sent.
  standIn.script.push((body) => {
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_reminder' });
    const facts = body.messages[0].content[0].text;
    assert.match(facts, /Customer: Saffron Foods/);
    assert.match(facts, /still to pay ₹25,000\.00/);
    return {
      content: [{ type: 'tool_use', id: 'toolu_c1', name: 'submit_reminder', input: { risk: 'MEDIUM', riskReasons: ['5 days overdue', 'No payment history yet'], subject: `Payment reminder: ${inv.number}`, body: `Dear Saffron Foods,\n\nInvoice ${inv.number} for ₹25,000.00 is now overdue. Please pay ₹25,000.00 at your earliest convenience, or reply if you already have.\n\nAccounts team, E2E Collectors Co` } }],
      stop_reason: 'tool_use',
      inputTokens: 812,
      outputTokens: 164,
    };
  });

  await page.getByRole('link', { name: 'Collections', exact: true }).click();
  await page.getByRole('heading', { name: 'Collections', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Draft reminders' }).click();
  const row = page.getByRole('link', { name: 'Saffron Foods: To review' });
  await row.waitFor();
  await page.getByText('1 customer left out').waitFor();
  await page.getByText('Customers left out of this run').click();
  await page.getByText(': No email address on the customer').waitFor();
  assert.equal(smtp.messages.filter((m) => m.to.includes(email)).length, 0, 'nothing is sent before review');

  // Review: the facts, the risk, and checks that run again on every edit.
  await row.click();
  await page.getByRole('heading', { name: 'Payment reminder for Saffron Foods' }).waitFor();
  const facts = page.getByLabel('Overdue invoices', { exact: true }).first();
  await facts.getByRole('link', { name: inv.number }).waitFor();
  await page.getByText('Medium risk').first().waitFor();
  await page.getByText('No payment history yet').waitFor();
  const checks = page.getByLabel('Checks against the books');
  await checks.getByText('Every amount matches the books').waitFor();
  const message = page.getByLabel('Message');
  const original = await message.inputValue();
  await message.fill(original.replace('Please pay ₹25,000.00', 'Please pay ₹26,000.00'));
  await checks.getByText('Amounts not in the books: ₹26,000.00').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send with my edits' }).isDisabled(), true);
  await message.fill(`${original}\n\nOur bank details are on the invoice.`);
  await checks.getByText('Every amount matches the books').waitFor();
  await page.getByRole('button', { name: 'Send with my edits' }).click();
  await page.getByLabel('Decision').getByText(/Approved by Collections Owner/).waitFor();
  await page.getByText('Edited before sending').waitFor();

  const sent = smtp.messages.filter((m) => m.to.includes(email));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, `Payment reminder: ${inv.number}`);
  assert.match(sent[0].text, /Our bank details are on the invoice\./);
  assert.match(sent[0].text, /Please pay ₹25,000\.00/);

  // The explainable AI log.
  await page.getByRole('link', { name: 'AI activity', exact: true }).click();
  await page.getByRole('heading', { name: 'AI activity', exact: true }).waitFor();
  const logRow = page.getByRole('row', { name: /Drafted a payment reminder for Saffron Foods \(risk medium\)/ });
  await logRow.getByText('Sent with edits by Collections Owner').waitFor();
  await logRow.getByText('812 / 164').waitFor();
  await logRow.getByRole('link').click();
  await page.getByRole('heading', { name: 'Payment reminder for Saffron Foods' }).waitFor();

  assert.deepEqual(consoleErrors, []);
});
