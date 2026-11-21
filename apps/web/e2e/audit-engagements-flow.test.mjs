/**
 * Browser end-to-end test for the internal audit workspace (AUDIT-001): the owner starts an
 * engagement led by the accountant and reviewed by the owner; the accountant plans a step, links a
 * finding, does the work and sends it for review; the owner signs the step off and closes the
 * engagement with its conclusion, and the history shows every change.
 * Real Next.js app → real API → real MongoDB.
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

test('an internal audit is planned, worked, signed off and closed', async () => {
  const owner = await open();
  await owner.goto(`${WEB}/register`);
  await owner.getByLabel('Full name').fill('Indira Internal');
  await owner.getByLabel('Email').fill(`e2e-engagement-${randomUUID()}@example.test`);
  await owner.getByLabel('Password').fill(password);
  await owner.getByRole('button', { name: 'Create account' }).click();
  await owner.waitForURL(/\/onboarding/);
  await owner.getByLabel('Organisation name').fill('E2E Internal Audit Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = owner.url();
  const orgId = orgUrl.split('/').pop();
  const accountantEmail = `e2e-engagement-acc-${randomUUID()}@example.test`;
  const reg = await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: accountantEmail, name: 'Lalit Lead', password }) });
  assert.equal(reg.status, 201);
  const accountantId = (await reg.json()).user?.id;
  assert.equal(await owner.evaluate(async ([id, email]) => (await fetch(`/api/t2t/v1/orgs/${id}/members`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ email, role: 'ACCOUNTANT' }) })).status, [orgId, accountantEmail]), 201);
  const finding = await owner.evaluate(
    async ([id, ownerId]) => (await fetch(`/api/t2t/v1/orgs/${id}/audit-findings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ title: 'Payments released before approval', description: 'Two payments left the bank before they were approved.', severity: 'MEDIUM', ownerId, plan: 'Approve every batch before release' }) })).status,
    [orgId, accountantId],
  );
  assert.equal(finding, 201);

  await owner.goto(`${orgUrl}/audit-engagements`);
  await owner.getByText('No internal audits yet').waitFor();
  await owner.getByLabel('Engagement name').fill('Q3 payments audit');
  await owner.getByLabel('Objective').fill('Check that supplier payments are approved before release');
  await owner.getByLabel('Lead').selectOption({ label: 'Lalit Lead' });
  await owner.getByLabel('Reviewer').selectOption({ label: 'Indira Internal' });
  await owner.getByRole('button', { name: 'Start engagement' }).click();
  await owner.getByRole('heading', { name: 'IA-001: Q3 payments audit' }).waitFor();
  await owner.getByText('Lalit Lead moves the engagement on.').waitFor();
  const engagementUrl = owner.url();

  // The lead plans, links the finding and does the work.
  const lead = await open();
  await lead.goto(`${WEB}/login`);
  await lead.getByLabel('Email').fill(accountantEmail);
  await lead.getByLabel('Password').fill(password);
  await lead.getByRole('button', { name: 'Sign in' }).click();
  await lead.waitForURL(/\/orgs\//);
  await lead.goto(engagementUrl);
  await lead.getByLabel('New step').fill('Trace payments to approved batches');
  await lead.getByLabel('Assign to').selectOption({ label: 'Lalit Lead' });
  await lead.getByRole('button', { name: 'Add step' }).click();
  await lead.getByRole('table', { name: 'Work programme' }).getByText('Trace payments to approved batches').waitFor();
  await lead.getByLabel('Link a sample or finding').selectOption({ label: 'F-001 Payments released before approval' });
  await lead.getByRole('button', { name: 'Link', exact: true }).click();
  await lead.getByRole('link', { name: 'F-001 Payments released before approval' }).waitFor();
  await lead.getByRole('button', { name: 'Start fieldwork' }).click();
  await lead.getByLabel('Work done on Trace payments to approved batches').fill('Traced 20 payments; two were released before approval');
  await lead.getByRole('button', { name: 'Mark done' }).click();
  await lead.getByText('Done, awaiting sign-off').waitFor();
  assert.equal(await lead.getByRole('button', { name: 'Sign off' }).count(), 0);
  await lead.getByRole('button', { name: 'Send for review' }).click();
  await lead.getByText('Waiting for Indira Internal to review.').waitFor();

  // The reviewer signs off and closes it.
  await owner.reload();
  await owner.getByRole('button', { name: 'Sign off' }).click();
  await owner.getByRole('table', { name: 'Work programme' }).getByText('Signed off', { exact: true }).waitFor();
  await owner.getByLabel('Conclusion, or what needs more work').fill('Payments are traced to batches; release before approval is raised as F-001');
  await owner.getByRole('button', { name: 'Close engagement' }).click();
  await owner.getByLabel('Conclusion').getByText('Payments are traced to batches; release before approval is raised as F-001').waitFor();
  const history = owner.getByRole('table', { name: 'Engagement history' });
  for (const t of ['Started', 'Step added', 'Finding linked', 'Fieldwork started', 'Step done', 'Sent for review', 'Step signed off', 'Closed']) await history.getByRole('cell', { name: new RegExp(`^${t}`) }).first().waitFor();
  await shot(owner, 'audit-engagement-closed');

  await owner.getByRole('link', { name: 'All engagements' }).click();
  await owner.getByRole('table', { name: 'Audit engagements' }).getByRole('row', { name: /Q3 payments audit/ }).getByText('Closed').waitFor();
  await shot(owner, 'audit-engagements');
  assert.deepEqual(consoleErrors, []);
});
