/**
 * Browser end-to-end test for the voice assistant: an owner speaks a question, sees it marked as
 * spoken, hears the answer read aloud, and confirms or cancels the actions the copilot proposed.
 * Real Next.js app → real API → real PostgreSQL → the real Anthropic SDK talking to a local
 * stand-in for the Messages API (see copilot-flow.test.mjs). The browser's speech recognition and
 * speech output are replaced by test doubles, because headless Chromium has no microphone or
 * speech service: the double "hears" a fixed sentence and records what would be spoken.
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
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );

before(async () => {
  standIn = await startAnthropicStandIn(STAND_IN_PORT);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    // Test double for the Web Speech API: "hears" window.__say, then ends.
    window.__spoken = [];
    class FakeRecognition {
      start() {
        const words = window.__say ?? '';
        setTimeout(() => this.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: words.split(' ').slice(0, 3).join(' ') } }] }), 50);
        setTimeout(() => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: words } }] }), 400);
        setTimeout(() => this.onend?.(), 450);
      }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = FakeRecognition;
    window.speechSynthesis.speak = (u) => window.__spoken.push(u.text);
    window.speechSynthesis.cancel = () => {};
  });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await standIn?.close();
});

test('an owner asks by voice, hears the answer, and confirms or cancels what the copilot proposes', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Vani Voice');
  await page.getByLabel('Email').fill(`e2e-voice-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Voice Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);

  await page.goto(`${WEB}/orgs/${orgId}/copilot`);
  await page.getByText('Talk2Tax receives only the text.').waitFor();

  // Spoken: the "model" proposes a task and says it waits for confirmation.
  standIn.script.push(
    (body) => {
      const q = body.messages.at(-1).content.at(-1).text;
      assert.equal(q, '(Asked by voice.) remind me to call Marigold Stores the day after tomorrow');
      return { content: [{ type: 'tool_use', id: 'toolu_v1', name: 'propose_task', input: { title: 'Call Marigold Stores', description: null, due_date: addDays(T, 2), for_role: null } }], stop_reason: 'tool_use' };
    },
    (body) => {
      const r = JSON.parse(body.messages.at(-1).content[0].content);
      assert.equal(r.done, false);
      return { content: [{ type: 'text', text: 'I have set up a task to call **Marigold Stores**. Press Confirm to create it.' }], stop_reason: 'end_turn' };
    },
  );
  await page.evaluate(() => (window.__say = 'remind me to call Marigold Stores the day after tomorrow'));
  await page.getByRole('button', { name: 'Speak' }).click();
  await page.waitForURL(/\?c=[0-9a-f-]{36}$/);
  const question = page.getByRole('group', { name: 'Question' });
  await question.getByText('remind me to call Marigold Stores the day after tomorrow').waitFor();
  await question.getByText(/Spoken ·/).waitFor();
  const card = page.getByRole('group', { name: 'Proposed action' });
  await card.getByText(`Create a task "Call Marigold Stores" for you, due ${addDays(T, 2)}.`).waitFor();
  await card.getByText('Waiting for you').waitFor();
  // The answer is read aloud, without markdown.
  await page.waitForFunction(() => window.__spoken.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__spoken), ['I have set up a task to call Marigold Stores. Press Confirm to create it.']);
  // Nothing exists until it is confirmed.
  assert.equal(JSON.stringify((await call(`${base}/tasks?scope=mine&status=ALL`)).body).includes('Call Marigold Stores'), false);
  await card.getByRole('button', { name: 'Confirm' }).click();
  await card.getByText('Done').waitFor();
  await card.getByRole('link', { name: 'Task "Call Marigold Stores"' }).waitFor();
  assert.equal(JSON.stringify((await call(`${base}/tasks?scope=mine&status=ALL`)).body).includes('Call Marigold Stores'), true);

  // Typed follow-up; this time the member cancels the proposal. Typed answers are not read aloud.
  standIn.script.push(
    () => ({ content: [{ type: 'tool_use', id: 'toolu_v2', name: 'propose_task', input: { title: 'Chase every overdue customer', description: null, due_date: null, for_role: 'ACCOUNTANT' } }], stop_reason: 'tool_use' }),
    () => ({ content: [{ type: 'text', text: 'Proposed a task for the accountants. Confirm it on the card.' }], stop_reason: 'end_turn' }),
  );
  await page.getByLabel('Your question').fill('and ask the accountants to chase every overdue customer');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const second = page.getByRole('group', { name: 'Proposed action' }).nth(1);
  await second.getByText('Create a task "Chase every overdue customer" for the accountants.').waitFor();
  await second.getByRole('button', { name: 'Cancel' }).click();
  await second.getByText('Cancelled').waitFor();
  assert.equal(await second.getByRole('button', { name: 'Confirm' }).count(), 0);
  assert.equal((await page.evaluate(() => window.__spoken)).length, 1);
  assert.equal(JSON.stringify((await call(`${base}/tasks?scope=all&status=ALL`)).body).includes('Chase every overdue customer'), false);

  // Turning reading aloud off is remembered.
  await page.getByLabel('Read spoken answers aloud').uncheck();
  await page.reload();
  assert.equal(await page.getByLabel('Read spoken answers aloud').isChecked(), false);
  assert.deepEqual(consoleErrors, []);
});
