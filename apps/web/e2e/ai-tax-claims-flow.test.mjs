/**
 * Browser end-to-end test for TAX-054: the AI copilot never passes off a tax rate or legal section
 * it recalled from memory as Talk2Tax's. The model (a local stand-in for the Messages API,
 * ANTHROPIC_BASE_URL=http://127.0.0.1:4555, so nothing reaches Anthropic) answers with one of the
 * organisation's own GST rates, a TDS rate and a section that nothing it was given contains. The
 * answer shows a warning naming the two unsupported claims and the sentence each came from, and
 * nothing for the supported rate. Real Next.js app -> real API -> real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const STAND_IN_PORT = +(process.env.ANTHROPIC_STAND_IN_PORT ?? 4555);
const SHOTS = process.env.SHOTS_DIR;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page, standIn;
const consoleErrors = [];

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

test('the copilot flags a tax rate and a section it could not find in Talk2Tax', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tax Claims Owner');
  await page.getByLabel('Email').fill(`e2e-ai-tax-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Tax Claims Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  assert.equal((await call(`${base}/tax-rates`, { name: 'Standard GST', rate: '18', salesAccountId: accounts['2300'], purchaseAccountId: accounts['1450'] })).status, 201);
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);

  standIn.script.push(() => ({ content: [{ type: 'text', text: 'GST on your sales is charged at 18%. TDS at 0.15% under section 194Q applies to large purchases.' }], stop_reason: 'end_turn' }));
  await page.goto(`${WEB}/orgs/${orgId}/copilot`);
  await page.getByLabel('Your question').fill('What tax applies when we buy goods in bulk?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const answer = page.getByRole('region', { name: 'Copilot answer' }).first();
  await answer.getByText('Check these tax details').waitFor();
  await answer.getByText(/This answer mentions 0\.15%, section 194Q, which Talk2Tax could not find/).waitFor();
  const items = await answer.getByRole('list', { name: 'Not found in Talk2Tax' }).getByRole('listitem').allInnerTexts();
  assert.deepEqual(items, [
    '0.15% (tax rate) in: "TDS at 0.15% under section 194Q applies to large purchases."',
    'section 194Q (legal reference) in: "TDS at 0.15% under section 194Q applies to large purchases."',
  ]);
  // The instructions sent to the model say not to state rates or sections from memory.
  assert.match(JSON.stringify(standIn.requests.at(-1).body.system), /Never state a tax rate, threshold, section, rule or legal requirement from memory/);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await answer.screenshot({ path: `${SHOTS}/copilot-tax-claims.png` });
  }

  // An answer without rates or references shows no warning.
  standIn.script.push(() => ({ content: [{ type: 'text', text: 'You have not recorded any purchases yet.' }], stop_reason: 'end_turn' }));
  await page.getByLabel('Your question').fill('How much did we buy this month?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const second = page.getByRole('region', { name: 'Copilot answer' }).last();
  await second.getByText('You have not recorded any purchases yet.').waitFor();
  assert.equal(await second.getByText('Check these tax details').count(), 0);

  assert.deepEqual(
    consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)),
    [],
  );
});
