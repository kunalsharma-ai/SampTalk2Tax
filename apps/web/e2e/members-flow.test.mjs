/**
 * Browser end-to-end test for invitations: an owner creates an invite link, the invitee
 * opens it signed out, creates an account with the invited email and joins; the owner
 * changes the role and removes them; a link opened with the wrong account is refused.
 * Real Next.js app → real API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const password = 'e2e-very-long-password';
const inviteeEmail = `e2e-invitee-${randomUUID()}@example.test`;
let browser, owner, invitee, orgId, link;
const consoleErrors = [];
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function register(page, name, email) {
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

before(async () => {
  browser = await chromium.launch();
  owner = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  invitee = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  for (const p of [owner, invitee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner creates an invite link', async () => {
  await owner.goto(`${WEB}/register`);
  await register(owner, 'Team Owner', `e2e-team-owner-${randomUUID()}@example.test`);
  await owner.waitForURL(/\/onboarding/);
  await owner.getByLabel('Organisation name').fill('E2E Team Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = owner.url().split('/').pop();
  await owner.goto(`${WEB}/orgs/${orgId}/members`);
  await owner.getByLabel('Email', { exact: true }).fill(inviteeEmail);
  await owner.getByLabel('Role', { exact: true }).selectOption('ACCOUNTANT');
  await owner.getByRole('button', { name: 'Create invite link' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByText(`Send this link to ${inviteeEmail}`).waitFor();
  link = await dialog.getByLabel('Invite link').inputValue();
  assert.match(link, /\/invite\/[A-Za-z0-9_-]{43}$/);
  await shot(owner, 'm1-invite-link');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await owner.getByRole('row', { name: new RegExp(inviteeEmail) }).getByText('pending').waitFor();
});

test('the invitee opens the link signed out, creates an account and joins', async () => {
  await invitee.goto(link);
  await invitee.waitForURL(/\/login\?next=/);
  await invitee.getByRole('link', { name: 'Create an account' }).click();
  await invitee.waitForURL(/\/register\?next=/);
  await register(invitee, 'New Accountant', inviteeEmail);
  await invitee.waitForURL(/\/invite\//);
  await invitee.getByRole('heading', { name: 'E2E Team Co' }).waitFor();
  await invitee.getByText('Team Owner invited you to join').waitFor();
  await shot(invitee, 'm2-accept');
  await invitee.getByRole('button', { name: 'Join E2E Team Co' }).click();
  await invitee.waitForURL(new RegExp(`/orgs/${orgId}$`));
  await invitee.getByText('ACCOUNTANT').first().waitFor();
});

test('the owner sees the new member, changes the role and removes them', async () => {
  await owner.reload();
  const row = owner.getByRole('row', { name: /New Accountant/ });
  await row.waitFor();
  await owner.getByRole('row', { name: new RegExp(inviteeEmail) }).getByText('accepted').waitFor();
  await row.getByLabel('Role for New Accountant').selectOption('VIEWER');
  await owner.waitForResponse((r) => r.url().includes('/members') && r.request().method() === 'GET');
  await shot(owner, 'm3-members');
  // The owner cannot demote themself while they are the only owner.
  await owner.getByLabel('Role for Team Owner').selectOption('ADMIN');
  await owner.getByText('An organisation must keep at least one owner').waitFor();

  await row.getByRole('button', { name: 'Remove New Accountant' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Remove member' }).click();
  await row.waitFor({ state: 'detached' });
  await invitee.goto(`${WEB}/orgs/${orgId}`);
  await invitee.getByText('Organisation not found or you do not have access.').waitFor();
});

test('a link opened with a different account is refused', async () => {
  await owner.getByLabel('Email', { exact: true }).fill(`someone-else-${randomUUID()}@example.test`);
  await owner.getByRole('button', { name: 'Create invite link' }).click();
  const other = await owner.getByRole('dialog').getByLabel('Invite link').inputValue();
  await owner.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await invitee.goto(other);
  await invitee.getByText(/This invitation is for someone-else-/).waitFor();
  assert.equal(await invitee.getByRole('button', { name: /^Join/ }).count(), 0);
  await shot(invitee, 'm4-wrong-account');
});

test('no unexpected console errors were logged', () => {
  const unexpected = consoleErrors.filter((e) => !/favicon/.test(e) && !/status of (404|409)/.test(e));
  assert.deepEqual(unexpected, [], consoleErrors.join('\n'));
});
