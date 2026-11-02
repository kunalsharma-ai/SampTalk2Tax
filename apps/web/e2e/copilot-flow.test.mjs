/**
 * Browser end-to-end test for the AI copilot: an owner turns it on, asks a question, sees
 * the answer with the reports it came from, gets a clear message when the provider fails,
 * asks again, and deletes the conversation. Real Next.js app → real API → real PostgreSQL →
 * the real Anthropic SDK, which talks to a local stand-in for the Messages API (the API
 * must run with ANTHROPIC_API_KEY set and ANTHROPIC_BASE_URL=http://127.0.0.1:4555). The
 * stand-in's replies are scripted here; it is not a model and nothing reaches Anthropic.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const STAND_IN_PORT = +(process.env.ANTHROPIC_STAND_IN_PORT ?? 4555);
let browser, page, orgId, base, accounts, standIn;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

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

test('an owner turns the copilot on, gets an answer with its sources, recovers from a provider error and deletes the conversation', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Copilot Owner');
  await page.getByLabel('Email').fill(`e2e-copilot-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Curious Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${base}/contacts`, { name: 'Marigold Stores', isCustomer: true })).body;
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, post: true, lines: [{ accountId: accounts['4100'], quantity: '2', unitPrice: '62500.00' }] })).status, 201);

  // Off until turned on, with what is sent spelled out.
  await page.getByRole('link', { name: 'Copilot', exact: true }).click();
  await page.getByRole('heading', { name: 'Copilot', exact: true }).waitFor();
  const card = page.getByLabel('Turn on the copilot');
  await card.getByText('The copilot is off for E2E Curious Co').waitFor();
  await card.getByText(/are sent to Anthropic’s claude-opus-5-5 model/).waitFor();
  assert.equal(await page.getByLabel('Your question').isDisabled(), true);
  await card.getByRole('button', { name: 'Turn on the copilot' }).click();
  await card.waitFor({ state: 'detached' });

  // A question: the "model" asks for the profit and loss, and answers from the figure it was given.
  standIn.script.push(
    () => ({ content: [{ type: 'thinking', thinking: 'Need this month’s P&L.', signature: 'sig-e2e-1' }, { type: 'tool_use', id: 'toolu_e2e_1', name: 'get_income_statement', input: { from: `${T.slice(0, 7)}-01`, to: T } }], stop_reason: 'tool_use' }),
    (body) => {
      const pl = JSON.parse(body.messages.at(-1).content[0].content);
      return { content: [{ type: 'text', text: `Revenue this month is **${pl.totalRevenue}** (Profit and loss).\n\n| Line | Amount |\n|---|---:|\n| Revenue | ${pl.totalRevenue} |\n| Net income | ${pl.netIncome} |` }], stop_reason: 'end_turn' };
    },
  );
  await page.getByRole('button', { name: 'What needs my attention right now?' }).click();
  assert.equal(await page.getByLabel('Your question').inputValue(), 'What needs my attention right now?');
  await page.getByLabel('Your question').fill('How much did we sell this month?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.waitForURL(/\?c=[0-9a-f-]{36}$/);
  const answer = page.getByRole('region', { name: 'Copilot answer' }).first();
  await answer.getByText('Revenue this month is').waitFor();
  await answer.getByRole('cell', { name: '125000.00' }).first().waitFor();
  const source = answer.getByRole('region', { name: 'Looked at' }).getByRole('link');
  assert.match(await source.innerText(), /^Profit and loss, 1 \w{3} \d{4} to \d+ \w{3} \d{4}$/);
  assert.equal(await source.getAttribute('href'), `/orgs/${orgId}/reports/income-statement`);
  await answer.getByText(/claude-opus-5-5 · 2,000 tokens in, 200 out/).waitFor();
  await page.getByRole('complementary', { name: 'Conversations' }).getByRole('button', { name: /How much did we sell this month\?/ }).waitFor();
  // What the API received came from the real books, through the real SDK.
  assert.equal(standIn.requests.length, 2);
  assert.equal(JSON.parse(standIn.requests[1].body.messages[2].content[0].content).totalRevenue, '125000.00');

  // A provider error is explained, and the question can be asked again.
  standIn.script.push(() => ({ status: 429, type: 'rate_limit_error', message: 'Slow down' }));
  await page.getByLabel('Your question').fill('And who owes us?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const failed = page.getByRole('region', { name: 'Copilot answer' }).nth(1);
  await failed.getByText('The AI provider is limiting requests right now. Try again in a minute.').waitFor();
  standIn.script.push(
    () => ({ content: [{ type: 'tool_use', id: 'toolu_e2e_2', name: 'get_ageing', input: { ledger: 'receivables', as_of: null } }], stop_reason: 'tool_use' }),
    (body) => {
      // The failed exchange is not replayed; the first one is, thinking included.
      assert.equal(body.messages[1].content[0].signature, 'sig-e2e-1');
      const ageing = JSON.parse(body.messages.at(-1).content[0].content);
      return { content: [{ type: 'text', text: `- ${ageing.rows[0].contactName} owes ${ageing.rows[0].balance}` }], stop_reason: 'end_turn' };
    },
  );
  await failed.getByRole('button', { name: 'Ask again' }).click();
  assert.equal(await page.getByLabel('Your question').inputValue(), 'And who owes us?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const third = page.getByRole('region', { name: 'Copilot answer' }).nth(2);
  await third.getByRole('listitem').filter({ hasText: 'Marigold Stores owes 125000.00' }).waitFor();
  assert.equal(await third.getByRole('region', { name: 'Looked at' }).getByRole('link').getAttribute('href'), `/orgs/${orgId}/sales/ageing`);

  // Delete the conversation.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete conversation' }).click();
  await page.getByText('Ask about your books').waitFor();
  assert.deepEqual((await call(`${base}/copilot/conversations`)).body, []);

  // Turned off again: nothing more can be asked.
  await page.getByRole('button', { name: 'Turn off for the organisation' }).click();
  await page.getByText('The copilot is off for E2E Curious Co').waitFor();
  assert.equal(await page.getByLabel('Your question').isDisabled(), true);
  assert.equal(standIn.requests.length, 5);
  assert.deepEqual(consoleErrors, []);
});
