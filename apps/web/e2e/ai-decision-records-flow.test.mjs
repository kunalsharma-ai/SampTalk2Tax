/**
 * Browser end-to-end test for the explainable AI ledger (AUDIT-018, 020, 021, 027, 029, 030):
 * an owner asks the AI for a bank line suggestion, then finds its decision record under AI
 * activity: the agent, who it acted for, the prompt and tool versions, the data it was given and
 * its own reason, with the hidden reasoning left out. Real
 * Next.js app → real API → real MongoDB → the real Anthropic SDK against a local stand-in
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

test('an AI call is recorded in the decision records with its agent, data and reason', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Ledger Owner');
  await page.getByLabel('Email').fill(`e2e-ai-ledger-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E AI Ledger Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const orgId = orgUrl.split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const bank = accounts['1120'];
  const csv = ['Date,Narration,Ref,Amount', `${dmy(addDays(T, -2))},BANK SERVICE FEE,,-250.00`].join('\n');
  assert.equal((await call(`${base}/banking/accounts/${bank}/imports`, { fileName: 'nov.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } })).status, 201);
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);
  standIn.script.push(() => ({
    content: [
      { type: 'thinking', thinking: 'Secret working: the fee looks monthly.', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_l1', name: 'submit_suggestion', input: { action: 'ENTRY', accountCode: '6900', entryDescription: 'Bank service fee', confidence: 'HIGH', reason: 'The narration says it is the bank fee for the month.' } },
    ],
    stop_reason: 'tool_use',
    inputTokens: 980,
    outputTokens: 60,
  }));
  const run = await call(`${base}/banking/accounts/${bank}/ai/runs`, {});
  assert.ok([200, 201].includes(run.status), `run started: ${run.status}`);

  await page.goto(`${orgUrl}/ai-activity`);
  const records = page.getByLabel('Decision records', { exact: true });
  const row = records.getByRole('row', { name: /Bank line assistant/ });
  await row.waitFor({ timeout: 20_000 });
  await row.getByText('The narration says it is the bank fee for the month.').waitFor();
  await row.getByText(/BANK SERVICE FEE/).waitFor();
  await row.getByText('Ledger Owner').waitFor();
  await row.getByText(/^prompt [0-9a-f]{12}$/).waitFor();
  await row.getByText("The model's hidden reasoning was not kept.").waitFor();
  assert.equal(await page.getByText('Secret working').count(), 0);
  await page.getByLabel('Agent').selectOption({ label: 'Copilot' });
  await page.getByText('No decision records yet').waitFor();
  await page.getByLabel('Agent').selectOption({ label: 'Bank line assistant' });
  await row.waitFor();
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/ai-decision-records.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
