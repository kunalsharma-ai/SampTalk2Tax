/**
 * Browser end-to-end test for access rules (SEC-004, attribute-based access control): an owner
 * limits viewers to the office network under Settings → Access rules, a viewer working from
 * elsewhere is refused with the rule named, and switching the rule off lets them in again.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
let browser;
const consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function register(name) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const email = `e2e-rules-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  return { page, email };
}

test('an owner limits viewers to the office network', async () => {
  const viewer = await register('Rules Viewer');
  const owner = await register('Rules Owner');
  const page = owner.page;
  await page.getByLabel('Organisation name').fill('E2E Access Rules Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const added = await page.evaluate(async ([orgId, email]) => (await fetch(`/api/t2t/v1/orgs/${orgId}/members`, { method: 'POST', headers: { 'x-t2t-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email, role: 'VIEWER' }) })).status, [orgUrl.split('/').pop(), viewer.email]);
  assert.equal(added, 201);

  await page.goto(`${orgUrl}/settings/access-rules`);
  await page.getByText('No access rules').waitFor();
  const you = await page.getByRole('region', { name: 'Your access now' }).innerText();
  assert.match(you, /Address/);
  await page.getByRole('button', { name: 'New rule' }).click();
  const form = page.getByRole('region', { name: 'Access rule' });
  await form.getByLabel('Name').fill('Office only');
  await form.getByLabel('Viewer', { exact: true }).check();
  await form.getByLabel('Networks').fill('office-wifi');
  await form.getByRole('button', { name: 'Save rule' }).click();
  await page.getByRole('alert').filter({ hasText: 'Not an IP address or range: office-wifi' }).waitFor();
  await form.getByLabel('Networks').fill('203.0.113.0/24');
  await form.getByRole('button', { name: 'Save rule' }).click();
  const table = page.getByRole('table', { name: 'Access rules' });
  const row = table.getByRole('row').filter({ hasText: 'Office only' });
  await row.waitFor();
  assert.match(await row.innerText(), /Viewers[\s\S]*From 203\.0\.113\.0\/24[\s\S]*On/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/access-rules.png`, fullPage: true });

  // The viewer is not on the office network: refused, with the rule named.
  const refused = await viewer.page.evaluate(async (orgId) => {
    const r = await fetch(`/api/t2t/v1/orgs/${orgId}/accounts`, { headers: { 'x-t2t-csrf': '1' } });
    return { status: r.status, body: await r.json() };
  }, orgUrl.split('/').pop());
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'ACCESS_RULE');
  await viewer.page.goto(`${orgUrl}/accounts`);
  const refusedCard = viewer.page.getByRole('region', { name: 'Not available from here' });
  await refusedCard.getByText(/access rule "Office only" allows access only from the organisation's listed networks/).waitFor();
  if (SHOTS) await viewer.page.screenshot({ path: `${SHOTS}/access-rule-refused.png` });

  // Switched off, the viewer is back in.
  await row.getByRole('button', { name: 'Edit' }).click();
  await form.getByLabel('The rule is on').uncheck();
  await form.getByRole('button', { name: 'Save rule' }).click();
  await table.getByRole('row').filter({ hasText: 'Office only' }).getByText('Off', { exact: true }).waitFor();
  const back = await viewer.page.evaluate(async (orgId) => (await fetch(`/api/t2t/v1/orgs/${orgId}/accounts`, { headers: { 'x-t2t-csrf': '1' } })).status, orgUrl.split('/').pop());
  assert.equal(back, 200);
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
