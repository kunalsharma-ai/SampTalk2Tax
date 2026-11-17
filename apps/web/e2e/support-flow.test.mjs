/**
 * Browser end-to-end test for support: an owner asks for help, a support agent answers from
 * Platform admin → Support, the owner gives support read-only access to the books from the
 * ticket, the agent reads them (and cannot change them), and the owner sees what was looked at
 * and ends the access. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
let browser;
const consoleErrors = [];

async function register(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  return page;
}

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

test('an owner asks for help and lets support read the books for a while', async () => {
  const tag = randomUUID().slice(0, 8);
  const owner = await register('Helpdesk Owner', `e2e-help-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Helpdesk Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().match(/orgs\/([0-9a-f-]{36})/)[1];

  // The owner opens a ticket.
  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Help and support' }).click();
  const form = owner.locator('[aria-label="New ticket"]');
  await form.getByLabel('Subject').fill(`Trial balance looks wrong ${tag}`);
  await form.getByLabel('Topic').selectOption('ACCOUNTING');
  await form.getByLabel('How urgent').selectOption('HIGH');
  await form.getByLabel('What is happening').fill('The trial balance for October does not show the opening balances.');
  await form.getByRole('button', { name: 'Send to support' }).click();
  await owner.waitForURL(/\/support\/[0-9a-f-]{36}$/);
  await owner.getByText('Waiting on support').waitFor();
  const ticketUrl = owner.url();

  // Support answers from the queue, with an internal note the owner never sees.
  const agentEmail = `e2e-help-agent-${tag}@example.test`;
  const agent = await register('Helpdesk Agent', agentEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', agentEmail, '--role', 'SUPPORT'], { cwd: API_DIR, encoding: 'utf8' });
  await agent.goto(`${WEB}/admin/support`);
  await agent.getByLabel('Search').fill(tag);
  await agent.locator('[aria-label="Support queue"]').getByRole('link', { name: `Trial balance looks wrong ${tag}` }).click();
  await agent.waitForURL(/\/admin\/support\/[0-9a-f-]{36}$/);
  const answer = agent.locator('form[aria-label="Answer"]');
  await answer.getByLabel('Internal note').check();
  await answer.getByLabel('Internal note (only support sees it)').fill('Probably opening balances were not imported.');
  await answer.getByRole('button', { name: 'Add note' }).click();
  await agent.getByText('Internal note, not shown to the customer').waitFor();
  await answer.getByLabel('Internal note').uncheck();
  await answer.getByLabel('Reply to the customer').fill('Could you give us read-only access for a day so we can look?');
  await answer.getByRole('button', { name: 'Send reply' }).click();
  await agent.getByText('Waiting on customer').waitFor();
  assert.match(await agent.locator('[aria-label="Organisation"]').innerText(), /Support cannot see this organisation's books/);

  // The owner sees the reply (not the note) and grants access from the ticket.
  await owner.goto(ticketUrl);
  await owner.getByText('Could you give us read-only access').waitFor();
  assert.equal(await owner.getByText('Probably opening balances').count(), 0);
  await owner.getByText('Waiting on you').waitFor();
  const access = owner.locator('[aria-label="Support access"]');
  await access.getByLabel('For').selectOption('24');
  await access.getByLabel('Why support needs to look').fill('Check the October opening balances');
  await access.getByRole('button', { name: 'Give read-only access' }).click();
  await access.getByText('Support can read your books until').waitFor();

  // The agent reads the books under the grant and cannot change anything.
  await agent.reload();
  await agent.getByRole('link', { name: 'Open the books, read-only' }).click();
  await agent.waitForURL(new RegExp(`/orgs/${orgId}$`));
  await agent.getByTestId('support-access-banner').waitFor();
  await agent.goto(`${WEB}/orgs/${orgId}/accounts`);
  await agent.getByText('Cash', { exact: false }).first().waitFor();
  const write = await agent.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/accounts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ code: '9999', name: 'x', type: 'EXPENSE' }) })).json(), orgId);
  assert.equal(write.error, 'SUPPORT_READ_ONLY');

  // The owner sees what was looked at and ends the access.
  await owner.goto(`${WEB}/orgs/${orgId}/support`);
  const looked = owner.getByRole('table', { name: 'What support looked at' });
  await looked.getByText('/accounts').first().waitFor();
  assert.match(await looked.innerText(), /Helpdesk Agent/);
  await owner.getByRole('button', { name: 'End access now' }).click();
  await owner.getByRole('button', { name: 'Give read-only access' }).waitFor();
  await agent.goto(`${WEB}/orgs/${orgId}/accounts`);
  await agent.getByText('Organisation not found or you do not have access.').waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/404|Failed to load resource/.test(e)), []);
});
