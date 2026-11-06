/**
 * Browser end-to-end test for usage metering: an owner uploads a receipt and sees it counted
 * under Governance → Usage against the plan, and a person who runs Talk2Tax sees the
 * organisation under Platform admin → Usage. Real Next.js app → real API → real PostgreSQL.
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

test('an upload is counted against the plan and shows for the organisation and the platform', async () => {
  const tag = randomUUID().slice(0, 8);
  const owner = await register('Usage Owner', `e2e-usage-owner-${tag}@example.test`);
  await owner.getByLabel('Organisation name').fill(`E2E Usage Traders ${tag}`);
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().match(/orgs\/([0-9a-f-]{36})/)[1];

  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Usage', exact: true }).click();
  const uploads = owner.locator('[aria-label="Uploads"]');
  await uploads.getByText(/^0/).first().waitFor();

  // A receipt attached to a journal, through the API the screens use.
  const status = await owner.evaluate(async (id) => {
    const h = { 'content-type': 'application/json', 'x-t2t-csrf': '1' };
    const accounts = await (await fetch(`/api/t2t/v1/orgs/${id}/accounts`)).json();
    const acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const day = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const j = await (await fetch(`/api/t2t/v1/orgs/${id}/journals`, { method: 'POST', headers: h, body: JSON.stringify({ date: day, memo: 'Receipt', lines: [{ accountId: acc['1120'], debit: '10' }, { accountId: acc['4100'], credit: '10' }] }) })).json();
    const r = await fetch(`/api/t2t/v1/orgs/${id}/attachments?entityType=JOURNAL_ENTRY&entityId=${j.id}&fileName=receipt.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t2t-csrf': '1' }, body: '%PDF-1.4\n% e2e receipt\n%%EOF\n' });
    return r.status;
  }, orgId);
  assert.equal(status, 201);
  await owner.reload();
  assert.match(await uploads.innerText(), /^Uploads[\s\S]*\n1\s/m);
  assert.match(await owner.locator('[aria-label="AI requests"]').innerText(), /AI requests/);
  await owner.getByRole('table').getByText(/\d{4}/).first().waitFor();

  const adminEmail = `e2e-usage-admin-${tag}@example.test`;
  const admin = await register('Usage Admin', adminEmail);
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'dist/admin/grant-admin.js', '--email', adminEmail, '--role', 'SUPPORT'], { cwd: API_DIR, encoding: 'utf8' });
  await admin.goto(`${WEB}/admin/usage`);
  const row = admin.locator('[aria-label="Usage by organisation"]').getByRole('row', { name: new RegExp(`E2E Usage Traders ${tag}`) });
  await row.waitFor();
  assert.match(await row.innerText(), /1 \//);

  assert.deepEqual(consoleErrors.filter((e) => !/404|Failed to load resource/.test(e)), []);
});
