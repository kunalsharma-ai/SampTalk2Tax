/**
 * Browser end-to-end test for regional deployment: a new organisation is stored in this server's
 * region, and once the operator hands it to another region (the real region:move command) this
 * server stops serving it and says where it lives. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
let browser, page;
const consoleErrors = [];

/** The operator's command, run as on the API host (it reads the same .env as the running API). */
function move(orgId, to, reason) {
  return execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/regions/move-org.js', '--org', orgId, '--to', to, '--reason', reason], {
    cwd: API_DIR,
    env: { ...process.env, REGION_DIRECTORY: JSON.stringify({ 'eu-frankfurt': { name: 'European Union (Frankfurt)', appUrl: 'https://eu.talk2tax.example' } }) },
    encoding: 'utf8',
  });
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an organisation is served only from the region its data lives in', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Region Owner');
  await page.getByLabel('Email').fill(`e2e-region-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);

  // Before it is created, the organisation says where its data will be stored.
  const note = page.getByTestId('data-region-note');
  await note.waitFor();
  assert.match(await note.innerText(), /Its data will be stored in .+ \([a-z0-9-]+\)/);
  await page.getByLabel('Organisation name').fill('E2E Region Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();

  // The account page shows where it is kept.
  await page.goto(`${WEB}/orgs/${orgId}/account`);
  await page.locator('[aria-label="Where your data is kept"]').waitFor();
  const kept = await page.getByTestId('org-data-region').innerText();
  assert.ok((await note.count()) === 0 && kept.length > 0);

  // The operator hands it to another region: this server now refuses it and says where it is.
  assert.match(move(orgId, 'eu-frankfurt', 'E2E: customer asked for EU hosting'), /moved from .+ to eu-frankfurt/);
  try {
    await page.goto(`${WEB}/orgs/${orgId}`);
    const panel = page.locator('section[aria-label="Kept in another region"]');
    await panel.waitFor();
    assert.match(await panel.innerText(), /E2E Region Traders/);
    assert.match(await panel.innerText(), /kept in eu-frankfurt/);
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).count(), 0);
    await page.locator('header select option', { hasText: 'E2E Region Traders (eu-frankfurt)' }).waitFor({ state: 'attached' });
    // Its pages are refused by the API too, not only hidden.
    const status = await page.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/accounts`, { headers: { 'x-t2t-csrf': '1' } })).status, orgId);
    assert.equal(status, 421);
  } finally {
    move(orgId, process.env.DEPLOYMENT_REGION ?? 'local', 'E2E: move cancelled');
  }
  await page.goto(`${WEB}/orgs/${orgId}`);
  await page.getByRole('navigation', { name: 'Main' }).waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/421|Misdirected/.test(e)), []);
});
