/**
 * Browser end-to-end test for Settings → Integrations: an owner sees the server's fallback in
 * use, adds the organisation's own Claude key and model and its own mail server in the page,
 * tests both for real (the official SDK against a local stand-in for the Messages API on port
 * 4555; nodemailer against a local SMTP server on port 4556), and the copilot then reports the
 * organisation's own key. The API must run with ANTHROPIC_API_KEY set,
 * ANTHROPIC_BASE_URL=http://127.0.0.1:4555, SMTP_URL=smtp://127.0.0.1:4556 and
 * WEBHOOK_ALLOW_PRIVATE_NETWORKS=true (the stand-ins are on this machine).
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
const KEY = 'sk-ant-e2e-0123456789-ownKEY7';
let browser, page, standIn, smtp, orgId, email;
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
  smtp = await startSmtpStandIn(SMTP_PORT);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => {
  await browser?.close();
  await standIn?.close();
  await smtp?.close();
});

test('an owner connects their own Claude key and mail server in the app and tests both', async () => {
  email = `e2e-int-${randomUUID()}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Integrations Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Own Keys');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();

  await page.getByRole('link', { name: 'Integrations', exact: true }).click();
  const ai = page.getByRole('region', { name: 'AI (Claude)' });
  const mail = page.getByRole('region', { name: 'Email (SMTP)' });
  await ai.getByText("In use: the server's key").waitFor();
  await mail.getByText("In use: the server's mail server").waitFor();

  // AI: a wrong key first, then the real one.
  await ai.getByLabel('API key').fill(KEY);
  await ai.getByLabel('Model').selectOption('claude-sonnet-5-5');
  await ai.getByRole('button', { name: 'Save' }).click();
  await ai.getByText('In use: your key').waitFor();
  await ai.getByText('A key ending …KEY7 is stored. Leave this empty to keep it.').waitFor();
  assert.equal(await ai.getByLabel('API key').inputValue(), '');
  standIn.script.push(() => ({ status: 401, type: 'authentication_error', message: 'invalid x-api-key' }));
  await ai.getByRole('button', { name: 'Test connection' }).click();
  await ai.getByRole('status', { name: 'Last test' }).getByText('Anthropic rejected the API key. Check that it is copied in full and still active.').waitFor();
  standIn.script.push((body) => ({ model: body.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  await ai.getByRole('button', { name: 'Test connection' }).click();
  await ai.getByRole('status', { name: 'Last test' }).getByText('Connected: claude-sonnet-5-5 answered.').waitFor();
  await ai.getByRole('status', { name: 'Last test' }).getByText('Working').waitFor();
  const req = standIn.requests[standIn.requests.length - 1];
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.equal(req.body.model, 'claude-sonnet-5-5');

  // Email: the organisation's own server, with a login and its own sender.
  await mail.getByLabel('Mail server').fill('127.0.0.1');
  await mail.getByLabel('Security').selectOption('NONE');
  await mail.getByLabel('Port').fill(String(SMTP_PORT));
  await mail.getByLabel('Username').fill('mailer@ownkeys.test');
  await mail.getByLabel('Password').fill('e2e-smtp-pass');
  await mail.getByLabel('Sender name').fill('Own Keys Accounts');
  await mail.getByLabel('Sender email').fill('accounts@ownkeys.test');
  await mail.getByRole('button', { name: 'Save' }).click();
  await mail.getByText('In use: your mail server').waitFor();
  const before = smtp.messages.length;
  await mail.getByRole('button', { name: 'Send a test email' }).click();
  await mail.getByRole('status', { name: 'Last test' }).getByText(`Connected to 127.0.0.1:${SMTP_PORT} and sent a test email to ${email}.`).waitFor();
  const m = smtp.messages[before];
  assert.equal(m.from, 'accounts@ownkeys.test');
  assert.deepEqual(m.to, [email.toLowerCase()]);
  assert.deepEqual(smtp.logins[smtp.logins.length - 1], { user: 'mailer@ownkeys.test', pass: 'e2e-smtp-pass' });

  // Nothing secret comes back to the browser.
  const v = await call(`/v1/orgs/${orgId}/integrations`);
  assert.equal(JSON.stringify(v.body).includes(KEY), false);
  assert.equal(JSON.stringify(v.body).includes('e2e-smtp-pass'), false);

  // The copilot now uses the organisation's own key.
  const s = await call(`/v1/orgs/${orgId}/copilot/status`);
  assert.equal(s.body.source, 'ORGANISATION');
  assert.equal(s.body.model, 'claude-sonnet-5-5');

  // Removing the mail server goes back to the server's.
  await mail.getByRole('button', { name: 'Remove' }).click();
  await mail.getByText("In use: the server's mail server").waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
