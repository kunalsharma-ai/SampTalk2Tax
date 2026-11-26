/**
 * Browser end-to-end test for AI performance (PERF-020): an owner asks the AI for bank line
 * suggestions on two bank lines, one answered and one refused by the AI service, then opens Governance →
 * AI performance and sees the calls, the failure and its reason, the time taken and the tokens,
 * with the chart's figures in a table. Real Next.js app → real API → real MongoDB → the real
 * Anthropic SDK against a local stand-in for the Messages API (port 4555). The API must run with
 * ANTHROPIC_API_KEY set and ANTHROPIC_BASE_URL=http://127.0.0.1:4555. Nothing reaches Anthropic.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const STAND_IN_PORT = +(process.env.ANTHROPIC_STAND_IN_PORT ?? 4555);
let browser, page, standIn;
let consoleErrors = [];
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
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await standIn?.close();
});

test('AI calls, a failure and its reason show under AI performance', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Perf Owner');
  await page.getByLabel('Email').fill(`e2e-ai-perf-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E AI Performance Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const base = `/v1/orgs/${orgUrl.split('/').pop()}`;

  await page.goto(`${orgUrl}/ai-performance`);
  await page.getByText('No AI calls in this period').waitFor();

  const accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const bank = accounts['1120'];
  const csv = ['Date,Narration,Ref,Amount', `${dmy(addDays(T, -2))},BANK SERVICE FEE,,-250.00`, `${dmy(addDays(T, -1))},CARD MACHINE RENT,,-400.00`].join('\n');
  assert.equal(
    (await call(`${base}/banking/accounts/${bank}/imports`, { fileName: 'nov.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }))
      .status,
    201,
  );
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);
  standIn.script.push(() => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_p1',
        name: 'submit_suggestion',
        input: { action: 'ENTRY', accountCode: '6900', entryDescription: 'Bank service fee', confidence: 'HIGH', reason: 'The narration says it is the bank fee.' },
      },
    ],
    stop_reason: 'tool_use',
    inputTokens: 1200,
    outputTokens: 80,
  }));
  // The second line's call is refused by the AI service: too many requests.
  standIn.script.push(() => ({ status: 429, type: 'rate_limit_error', message: 'Slow down' }));
  const run = await call(`${base}/banking/accounts/${bank}/ai/runs`, {});
  assert.ok([200, 201].includes(run.status), `run started: ${run.status}`);
  consoleErrors = [];

  // Both calls are recorded once the runs finish.
  let calls = 0;
  for (let i = 0; i < 80 && calls < 2; i++) {
    calls = (await call(`${base}/ai-decisions/performance?days=7`)).body?.totals?.calls ?? 0;
    if (calls < 2) await page.waitForTimeout(250);
  }
  assert.equal(calls, 2);

  await page.goto(`${orgUrl}/ai-performance`);
  await page.getByRole('heading', { name: 'AI performance', exact: true }).waitFor();
  const agents = page.getByRole('table', { name: 'AI assistants' });
  const row = agents.getByRole('row', { name: /Bank line assistant/ });
  await row.waitFor();
  await row.getByRole('cell', { name: '2', exact: true }).first().waitFor();
  await row.getByText('1 (50%)', { exact: true }).waitFor();
  await row.getByText('1,200 / 80', { exact: true }).waitFor();
  const failures = page.getByRole('table', { name: 'Failed AI calls' });
  await failures.getByRole('cell', { name: 'Bank line assistant' }).waitFor();
  assert.match(await failures.getByRole('row').nth(1).innerText(), /RateLimitError/);
  await page.getByRole('img', { name: /AI calls each day.*table below/ }).waitFor();
  await page.getByText('The figures as a table').click();
  const today = page.getByRole('table', { name: 'AI calls each day' }).getByRole('row').last();
  assert.match(await today.innerText(), /\t2\t1\t/);
  // Only figures: nothing the AI said.
  assert.equal(await page.getByText('The narration says it is the bank fee.').count(), 0);

  await page.getByLabel('Period').selectOption({ label: 'Last 90 days' });
  await page.getByRole('table', { name: 'AI calls each day' }).getByRole('row').nth(90).waitFor();
  if (process.env.E2E_SCREENSHOTS) {
    await page.getByLabel('Period').selectOption({ label: 'Last 7 days' });
    await page.getByRole('table', { name: 'AI calls each day' }).getByRole('row').nth(7).waitFor();
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/ai-performance.png`, fullPage: true });
  }
  assert.deepEqual(consoleErrors, []);
});
