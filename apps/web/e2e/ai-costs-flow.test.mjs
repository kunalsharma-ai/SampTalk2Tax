/**
 * Browser end-to-end test for AI model costs (AGENT-053): after the collections agent drafts a
 * reminder, an owner sees its tokens under Model prices with no price set, sets the model's price
 * per million tokens, and sees the cost this month for the agent and in total.
 * Real Next.js app → real API → real MongoDB → the real Anthropic SDK against a local stand-in
 * for the Messages API (port 4555).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
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

test('an owner prices a model and sees what the AI agents cost this month', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Cost Owner');
  await page.getByLabel('Email').fill(`e2e-ai-costs-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E AI Costs Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const contact = (await call(`${base}/contacts`, { name: 'Anchor Foods', isCustomer: true, email: 'ap@anchor.test' })).body.id;
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: contact, issueDate: addDays(T, -45), dueDate: addDays(T, -30), post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '40000.00' }] })).status, 201);
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);
  standIn.script.push(() => ({
    content: [{ type: 'tool_use', id: 'toolu_c1', name: 'submit_reminder', input: { risk: 'MEDIUM', riskReasons: ['30 days overdue'], subject: 'Payment reminder', body: 'Dear Anchor Foods,\n\nPlease pay what is overdue.\n\nAccounts team' } }],
    stop_reason: 'tool_use', inputTokens: 1800, outputTokens: 300,
  }));
  assert.equal((await call(`${base}/collections/runs`, {})).status, 201);
  for (let i = 0; i < 50 && (await call(`${base}/collections/reminders`)).body.some((r) => r.status === 'DRAFTING'); i++) await page.waitForTimeout(200);
  const used = (await call(`${base}/ai-control`)).body.modelsUsed;
  assert.equal(used.length, 1, JSON.stringify(used));
  const model = used[0];

  await page.getByRole('link', { name: 'AI control center', exact: true }).click();
  await page.getByRole('heading', { name: 'AI control center', exact: true }).waitFor();
  const prices = page.getByRole('region', { name: 'Model prices' });
  const row = prices.getByRole('row', { name: new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  await row.getByText('No price set').waitFor();
  await row.getByText('2,100', { exact: true }).waitFor();
  await page.getByText('2,100 tokens not priced').first().waitFor();

  await row.getByRole('button', { name: `Set the price of ${model}` }).click();
  assert.equal(await prices.getByLabel('Model', { exact: true }).inputValue(), model);
  await prices.getByLabel('Input, US$ per million tokens').fill('10');
  await prices.getByLabel('Output, US$ per million tokens').fill('50');
  await prices.getByRole('button', { name: 'Save price' }).click();
  // 1,800 tokens in at $10 and 300 out at $50 per million: $0.018 + $0.015.
  await row.getByText('$10.00').waitFor();
  await row.getByText('$50.00').waitFor();
  await row.getByText('$0.03').waitFor();
  await row.getByText(/Cost Owner, /).waitFor();
  const collections = page.getByLabel('Collections agent: On');
  await collections.getByText('$0.03').waitFor();
  await page.getByText('At your model prices').waitFor();
  assert.equal((await call(`${base}/ai-control`)).body.totals.cost, '0.0330');
  if (SHOTS) {
    await prices.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/ai-model-prices.png` });
  }

  await row.getByRole('button', { name: `Remove the price of ${model}` }).click();
  await row.getByText('No price set').waitFor();
  assert.deepEqual(consoleErrors, []);
});
