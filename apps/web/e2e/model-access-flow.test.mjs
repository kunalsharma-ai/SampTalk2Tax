/**
 * Browser end-to-end test for model access policies (SEC-034): an owner narrows the AI models
 * their organisation allows in the AI control center and sees that the model in use is no longer
 * allowed, Settings → Integrations offers only allowed models, and a platform administrator limits
 * the models across Talk2Tax under Platform admin → AI shutdown, then allows every model again.
 * Real Next.js app → real API → real MongoDB.
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
const call = (page, path, body, method = 'POST') =>
  page.evaluate(async ([p, b, m]) => {
    const r = await fetch(`/api/t2t${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [path, body, method]);

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
  // Never leave the models limited for the other browser tests.
  if (admin) await call(admin, '/v1/admin/ai/models', { allowed: null, reason: 'End of the model access browser test' });
  await browser?.close();
});

test('an owner narrows the allowed models, and an administrator limits them across Talk2Tax', async () => {
  const tag = randomUUID().slice(0, 8);
  const adminEmail = `e2e-models-admin-${tag}@example.test`;
  admin = await register('Models Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail], { cwd: API_DIR, encoding: 'utf8' });
  await call(admin, '/v1/admin/ai/models', { allowed: null, reason: 'Start of the model access browser test' });

  const owner = await register('Models Owner', `e2e-models-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Model Rules Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();

  // The organisation allows only the smaller models: the server's default is then not allowed.
  await owner.goto(`${WEB}/orgs/${orgId}/ai-control`);
  const card = owner.getByRole('region', { name: 'Model access' });
  await card.getByText('Every model Talk2Tax allows can be used.').waitFor();
  await card.getByLabel('Allow claude-opus-5-5').click();
  await card.getByText('The model in use is not allowed').waitFor();
  await card.getByText('Only the ticked models can be used.').waitFor();
  const view = (await call(owner, `/v1/orgs/${orgId}/ai-control`, null, 'GET')).body.modelAccess;
  assert.deepEqual(view.organisation, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await card.screenshot({ path: `${SHOTS}/model-access.png` });
  }

  // Settings → Integrations offers only the allowed models.
  await owner.goto(`${WEB}/orgs/${orgId}/settings/integrations`);
  const ai = owner.getByRole('region', { name: 'AI (Claude)' });
  await ai.getByText('This model is not allowed').waitFor();
  assert.equal(await ai.locator('option[value="claude-opus-5-5"]').isDisabled(), true);
  assert.equal(await ai.locator('option[value="claude-haiku-5-5"]').isDisabled(), false);

  // Back to every model.
  await owner.goto(`${WEB}/orgs/${orgId}/ai-control`);
  await card.getByRole('button', { name: 'Allow every model' }).click();
  await card.getByText('Every model Talk2Tax allows can be used.').waitFor();

  // The administrator limits the models across Talk2Tax.
  await admin.goto(`${WEB}/admin/ai`);
  const models = admin.getByRole('region', { name: 'Models allowed on Talk2Tax' });
  await models.getByText('Every model is allowed.').waitFor();
  await models.getByLabel('Allow claude-opus-5-5 on Talk2Tax').click();
  await models.getByLabel('Reason for the change').fill('Cost review of the largest model');
  await models.getByRole('button', { name: 'Save allowed models' }).click();
  await models.getByText('Limited to the ticked models.').waitFor();
  assert.match(await models.getByRole('table', { name: 'Allowed model changes' }).innerText(), /claude-haiku-5-5, claude-sonnet-5-5\s+Cost review of the largest model\s+Models Admin/);
  if (SHOTS) await models.screenshot({ path: `${SHOTS}/admin-allowed-models.png` });

  // The organisation sees the platform's limit, and cannot allow that model back.
  await owner.reload();
  await card.getByText(/not allowed on Talk2Tax by the people who run it/).waitFor();
  assert.equal(await card.getByLabel('Allow claude-opus-5-5').isDisabled(), true);
  await card.getByText('The model in use is not allowed').waitFor();

  // Every model again.
  await models.getByLabel('Allow claude-opus-5-5 on Talk2Tax').click();
  await models.getByLabel('Reason for the change').fill('Cost review finished, all models back');
  await models.getByRole('button', { name: 'Save allowed models' }).click();
  await models.getByText('Every model is allowed.').waitFor();
  await owner.reload();
  await card.getByText('Every model Talk2Tax allows can be used.').waitFor();
  assert.equal(await card.getByText('The model in use is not allowed').count(), 0);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
