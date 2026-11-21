/**
 * Browser end-to-end test for segregation-of-duties checks (AUDIT-014): the owner writes and posts
 * a journal alone, sees it flagged and cannot clear it; an approver opens the check, reviews the
 * finding with a reason, and it shows as reviewed. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.T2T_API_URL ?? 'http://localhost:4000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const password = 'e2e-very-long-password';
let browser;
const consoleErrors = [];
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);
const open = async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  return page;
};

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

test('a journal posted by its author is flagged and cleared by an approver', async () => {
  const owner = await open();
  await owner.goto(`${WEB}/register`);
  await owner.getByLabel('Full name').fill('Sana Separate');
  await owner.getByLabel('Email').fill(`e2e-sod-${randomUUID()}@example.test`);
  await owner.getByLabel('Password').fill(password);
  await owner.getByRole('button', { name: 'Create account' }).click();
  await owner.waitForURL(/\/onboarding/);
  await owner.getByLabel('Organisation name').fill('E2E Duties Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = owner.url();
  const orgId = orgUrl.split('/').pop();

  // An approver joins; the owner writes and posts a journal on their own.
  const approverEmail = `e2e-sod-approver-${randomUUID()}@example.test`;
  assert.equal((await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: approverEmail, name: 'Arjun Approver', password }) })).status, 201);
  const statuses = await owner.evaluate(
    async ([id, email]) => {
      const h = { 'content-type': 'application/json', 'x-t2t-csrf': '1' };
      const added = await fetch(`/api/t2t/v1/orgs/${id}/members`, { method: 'POST', headers: h, body: JSON.stringify({ email, role: 'APPROVER' }) });
      const acc = Object.fromEntries((await (await fetch(`/api/t2t/v1/orgs/${id}/accounts`)).json()).map((a) => [a.code, a.id]));
      const day = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
      const j = await fetch(`/api/t2t/v1/orgs/${id}/journals`, { method: 'POST', headers: h, body: JSON.stringify({ date: day, post: true, memo: 'Year-end bonus accrual', lines: [{ accountId: acc['6200'], debit: '45000' }, { accountId: acc['1120'], credit: '45000' }] }) });
      return [added.status, j.status];
    },
    [orgId, approverEmail],
  );
  assert.deepEqual(statuses, [201, 201]);

  await owner.goto(`${orgUrl}/segregation-of-duties`);
  const findings = owner.getByRole('table', { name: 'Segregation findings' });
  const row = findings.getByRole('row', { name: /Journal prepared and posted by the same person/ });
  await row.waitFor();
  await row.getByText('Sana Separate').waitFor();
  await row.getByText('Someone else must review this').waitFor();
  assert.equal(await row.getByRole('button', { name: /^Review / }).count(), 0);
  await owner.getByRole('table', { name: 'Conflicting duties' }).getByRole('row', { name: /Sana Separate/ }).getByText('Prepare and post journals').waitFor();
  await shot(owner, 'segregation-of-duties-findings');

  // The approver reviews it.
  const approver = await open();
  await approver.goto(`${WEB}/login`);
  await approver.getByLabel('Email').fill(approverEmail);
  await approver.getByLabel('Password').fill(password);
  await approver.getByRole('button', { name: 'Sign in' }).click();
  await approver.waitForURL(/\/orgs\//);
  await approver.goto(`${orgUrl}/segregation-of-duties`);
  await approver.getByRole('button', { name: /^Review Journal #/ }).click();
  await approver.getByLabel(/^Why Journal #\d+ is fine$/).fill('Checked the bonus schedule approved by the board');
  await approver.getByRole('button', { name: 'Clear finding' }).click();
  await approver.getByText('Every finding is reviewed').waitFor();
  await approver.getByLabel('Open only').uncheck();
  await approver.getByText('Checked the bonus schedule approved by the board').waitFor();
  await approver.getByRole('table', { name: 'Segregation findings' }).getByText('Reviewed', { exact: true }).waitFor();
  await shot(approver, 'segregation-of-duties-reviewed');
  assert.deepEqual(consoleErrors, []);
});
