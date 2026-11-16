/**
 * Browser end-to-end test for the AI control center: an owner sees every agent with its
 * action level, sees this month's usage after the collections agent drafts a reminder, sets
 * a budget, turns an agent off and on, presses the emergency stop with a reason (which the
 * copilot then shows), and turns AI back on. Real Next.js app → real API → real PostgreSQL →
 * the real Anthropic SDK against a local stand-in for the Messages API (port 4555).
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
const addDays = (iso, d) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

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

test('an owner governs the AI agents and uses the emergency stop', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Control Owner');
  await page.getByLabel('Email').fill(`e2e-ai-control-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E AI Control Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const contact = (await call(`${base}/contacts`, { name: 'Anchor Foods', isCustomer: true, email: 'ap@anchor.test' })).body.id;
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: contact, issueDate: addDays(T, -45), dueDate: addDays(T, -30), post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '40000.00' }] })).status, 201);
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);
  standIn.script.push(() => ({
    content: [{ type: 'tool_use', id: 'toolu_r1', name: 'submit_reminder', input: { risk: 'MEDIUM', riskReasons: ['30 days overdue'], subject: 'Payment reminder', body: 'Dear Anchor Foods,\n\nPlease pay what is overdue.\n\nAccounts team' } }],
    stop_reason: 'tool_use', inputTokens: 1800, outputTokens: 300,
  }));
  assert.equal((await call(`${base}/collections/runs`, {})).status, 201);
  for (let i = 0; i < 50 && (await call(`${base}/collections/reminders`)).body.some((r) => r.status === 'DRAFTING'); i++) await page.waitForTimeout(200);

  await page.getByRole('link', { name: 'AI control center', exact: true }).click();
  await page.getByRole('heading', { name: 'AI control center', exact: true }).waitFor();
  const collections = page.getByLabel('Collections agent: On');
  await collections.waitFor();
  await collections.getByText('Level 2: Prepare changes for approval').waitFor();
  await collections.getByText('2,100', { exact: true }).waitFor();
  await page.getByLabel('Finance copilot: On').getByText('Level 0: Read-only analysis').waitFor();
  await collections.getByText(/0 accepted, 0 rejected, 1 waiting for a person/).waitFor();

  await collections.getByRole('button', { name: 'Set budget…' }).click();
  await collections.getByLabel('Monthly token budget').fill('500');
  await collections.getByText('Use a whole number from 1,000 to 1,000,000,000').waitFor();
  await collections.getByLabel('Monthly token budget').fill('10000');
  await collections.getByRole('button', { name: 'Save budget' }).click();
  await collections.getByText('2,100 of 10,000 tokens (21%)').waitFor();
  assert.equal(await collections.getByRole('meter').getAttribute('aria-valuenow'), '21');

  await page.getByLabel('Bank reconciliation agent: On').getByRole('button', { name: 'Turn off bank reconciliation agent' }).click();
  const bankOff = page.getByLabel('Bank reconciliation agent: Off');
  await bankOff.waitFor();
  await bankOff.getByText(/Changed by Control Owner/).waitFor();
  const blocked = await call(`${base}/banking/accounts/${acc['1120']}/ai/runs`, {});
  assert.equal(blocked.body?.error, 'AGENT_OFF');
  consoleErrors.splice(0); // the refused request above is expected
  await bankOff.getByRole('button', { name: 'Turn on bank reconciliation agent' }).click();
  await page.getByLabel('Bank reconciliation agent: On').waitFor();

  const ai = page.getByLabel('AI for this organisation');
  await ai.getByRole('button', { name: 'Emergency stop…' }).click();
  const stopNow = ai.getByRole('button', { name: 'Stop all AI now' });
  assert.equal(await stopNow.isDisabled(), true, 'a reason is needed');
  await ai.getByLabel('Why stop AI?').fill('Reviewing what the agents send out');
  await stopNow.click();
  await ai.getByText('Stopped: Reviewing what the agents send out').waitFor();
  await ai.getByText('Stopped', { exact: true }).waitFor();
  const q = await call(`${base}/copilot/conversations`, { question: 'What is my cash balance?' });
  assert.equal(q.status, 409);
  assert.match(q.body.message, /Reviewing what the agents send out/);
  consoleErrors.splice(0); // the refused question above is expected
  await page.getByRole('link', { name: 'Copilot', exact: true }).click();
  await page.getByText('AI was stopped', { exact: true }).waitFor();
  await page.getByText(/AI was stopped for this organisation: Reviewing what the agents send out/).waitFor();
  await page.getByRole('link', { name: 'Open the AI control center.' }).click();
  await page.getByRole('heading', { name: 'AI control center', exact: true }).waitFor();

  await ai.getByRole('button', { name: 'Turn AI back on' }).click();
  await ai.getByText('On', { exact: true }).waitFor();
  assert.equal((await call(`${base}/ai-control`)).body.offReason, null);

  await page.getByRole('link', { name: 'Audit trail', exact: true }).click();
  await page.getByText('ai.emergency_stop').first().waitFor();
  assert.deepEqual(consoleErrors, []);
});
