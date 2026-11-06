/**
 * Browser end-to-end test for operations: a person who runs Talk2Tax switches a module off
 * (it leaves the owner's menu and the API refuses it), puts the service into maintenance
 * (everyone sees the banner, changes are refused, reading works), and reads system health.
 * Real Next.js app → real API → real PostgreSQL.
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

test('flags hide and refuse a module, maintenance pauses changes for everyone, health is measured', async () => {
  const tag = randomUUID().slice(0, 8);
  const owner = await register('Ops Owner', `e2e-ops-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Ops Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().match(/orgs\/([0-9a-f-]{36})/)[1];
  const menu = owner.getByRole('navigation', { name: 'Main' });
  await menu.getByRole('link', { name: 'Benchmarking', exact: true }).waitFor();

  const adminEmail = `e2e-ops-admin-${tag}@example.test`;
  const admin = await register('Ops Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail, '--role', 'SUPER_ADMIN'], { cwd: API_DIR, encoding: 'utf8' });

  try {
    // Switch benchmarking off for everyone.
    await admin.goto(`${WEB}/admin/flags`);
    const card = admin.getByRole('region', { name: 'Benchmarking' }).or(admin.locator('[aria-label="Benchmarking"]')).first();
    await card.getByLabel('Switch').selectOption('off');
    await card.getByLabel('Note').fill('E2E check');
    await card.getByRole('button', { name: 'Save' }).click();
    await admin.locator('[aria-label="Benchmarking"]').getByTestId('flag-state').getByText('Off', { exact: true }).waitFor();

    await owner.reload();
    await menu.getByRole('link', { name: 'Budgets', exact: true }).waitFor();
    await owner.waitForLoadState('networkidle');
    assert.equal(await menu.getByRole('link', { name: 'Benchmarking', exact: true }).count(), 0);
    const refused = await owner.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/benchmarking`)).json(), orgId);
    assert.equal(refused.error, 'FEATURE_OFF');

    // Back to its default: on again.
    await admin.locator('[aria-label="Benchmarking"]').getByRole('button', { name: 'Back to default' }).click();
    await admin.locator('[aria-label="Benchmarking"]').getByTestId('flag-state').getByText('On (default)').waitFor();
    await owner.reload();
    await menu.getByRole('link', { name: 'Benchmarking', exact: true }).waitFor();

    // Maintenance: start now.
    await admin.goto(`${WEB}/admin/maintenance`);
    await admin.getByLabel('Message for everyone').fill(`Database upgrade ${tag}.`);
    await admin.getByRole('button', { name: 'Start now' }).click();
    await admin.getByRole('heading', { name: 'Maintenance in progress' }).waitFor();

    await owner.reload();
    const banner = owner.getByTestId('maintenance-banner');
    await banner.waitFor();
    assert.match(await banner.innerText(), new RegExp(`Maintenance in progress: Database upgrade ${tag}\\.`));
    const write = await owner.evaluate(async (id) => {
      const r = await fetch(`/api/t2t/v1/orgs/${id}/contacts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ name: 'Paused Ltd', type: 'CUSTOMER' }) });
      return { status: r.status, body: await r.json() };
    }, orgId);
    assert.equal(write.status, 503);
    assert.equal(write.body.error, 'MAINTENANCE');
    const read = await owner.evaluate(async (id) => (await fetch(`/api/t2t/v1/orgs/${id}/accounts`)).status, orgId);
    assert.equal(read, 200);

    // Signed-out visitors see it on the sign-in page too.
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`${WEB}/login`);
    await visitor.getByTestId('maintenance-banner').waitFor();

    await admin.getByRole('button', { name: 'End maintenance' }).click();
    await admin.locator('[aria-label="Start maintenance"]').waitFor();
    await owner.reload();
    await menu.getByRole('link', { name: 'Budgets', exact: true }).waitFor();
    assert.equal(await owner.getByTestId('maintenance-banner').count(), 0);
  } finally {
    // Never leave the shared database in maintenance or with a flag changed.
    await admin.evaluate(async () => {
      const h = { 'x-t2t-csrf': '1' };
      await fetch('/api/t2t/v1/admin/flags/benchmarking', { method: 'DELETE', headers: h });
      const list = await (await fetch('/api/t2t/v1/admin/maintenance')).json();
      for (const w of list) if (w.state !== 'ENDED') await fetch(`/api/t2t/v1/admin/maintenance/${w.id}/end`, { method: 'POST', headers: h });
    });
  }

  // System health and errors.
  await admin.goto(`${WEB}/admin/system`);
  await admin.locator('[aria-label="Background runners"]').getByText('Workflow runner').waitFor();
  await admin.locator('[aria-label="Database"]').getByText('PostgreSQL').waitFor();
  await admin.locator('[aria-label="Routes"]').getByText(/GET \/v1\/orgs\/:orgId/).first().waitFor();
  await admin.goto(`${WEB}/admin/errors`);
  await admin.locator('[aria-label="Error groups"]').waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/404|403|503|Failed to load resource/.test(e)), []);
});
