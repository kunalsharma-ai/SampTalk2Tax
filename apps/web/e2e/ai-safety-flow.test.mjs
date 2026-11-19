/**
 * Browser end-to-end test for AI safety controls: an organisation's owner turns a copilot tool
 * off in the AI control center (SEC-030), and a platform administrator stops AI for every
 * organisation under Platform admin → AI shutdown (SEC-038); the owner sees why, and AI comes
 * back when the administrator turns it on again. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const SHOTS = process.env.SHOTS_DIR;
let browser;
let admin;
const consoleErrors = [];
const post = (page, path, body) => page.evaluate(async ([p, b]) => (await fetch(`/api/t2t${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify(b) })).status, [path, body]);

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
  // Never leave AI stopped for the other browser tests.
  if (admin) await post(admin, '/v1/admin/ai/resume', { reason: 'End of the AI safety browser test' });
  await browser?.close();
});

test('an owner limits copilot tools, and an administrator stops and resumes AI for everyone', async () => {
  const tag = randomUUID().slice(0, 8);
  const adminEmail = `e2e-ai-admin-${tag}@example.test`;
  admin = await register('AI Shutdown Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });
  // A stop left by an earlier run is lifted first.
  await post(admin, '/v1/admin/ai/resume', { reason: 'Start of the AI safety browser test' });

  const owner = await register('AI Safety Owner', `e2e-ai-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E AI Safety Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();

  // Copilot tools: turn the balance sheet off.
  await owner.goto(`${WEB}/orgs/${orgId}/ai-control`);
  const tools = owner.getByRole('table', { name: 'Copilot tools' });
  await tools.waitFor();
  const balanceSheet = owner.getByLabel('Allow Balance sheet', { exact: true });
  assert.equal(await balanceSheet.isChecked(), true);
  await balanceSheet.click();
  await tools.getByRole('row').filter({ hasText: 'get_balance_sheet' }).getByText('Off', { exact: true }).waitFor();
  const status = await owner.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/copilot/status`)).json(), orgId);
  assert.deepEqual(status.disabledTools, ['get_balance_sheet']);

  // The administrator stops AI for everyone.
  await admin.goto(`${WEB}/admin`);
  await admin.getByRole('link', { name: 'AI shutdown', exact: true }).click();
  await admin.waitForURL(/\/admin\/ai$/);
  await admin.getByText('AI is running').waitFor();
  await admin.getByLabel('Reason', { exact: true }).fill('Provider incident under investigation');
  await admin.getByRole('button', { name: 'Stop AI for everyone' }).click();
  await admin.getByText('AI is stopped for everyone').waitFor();
  assert.match(await admin.getByRole('table', { name: 'Shutdown history' }).innerText(), /Stopped\s+Provider incident under investigation\s+AI Shutdown Admin/);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await admin.screenshot({ path: `${SHOTS}/admin-ai-shutdown.png`, fullPage: true });
  }

  // The owner sees why.
  await owner.reload();
  await owner.getByText('AI is stopped across Talk2Tax').waitFor();
  await owner.getByText(/Provider incident under investigation/).first().waitFor();
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/ai-control-shutdown.png`, fullPage: true });

  // Turned back on.
  await admin.getByLabel('Reason', { exact: true }).fill('Provider confirmed the incident is over');
  await admin.getByRole('button', { name: 'Turn AI back on' }).click();
  await admin.getByText('AI is running').waitFor();
  await owner.reload();
  await owner.getByRole('table', { name: 'Copilot tools' }).waitFor();
  assert.equal(await owner.getByText('AI is stopped across Talk2Tax').count(), 0);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
