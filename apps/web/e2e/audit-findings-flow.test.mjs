/**
 * Browser end-to-end test for audit findings and remediation (AUDIT-011, AUDIT-012): the owner
 * raises a finding for the accountant to fix; the accountant records progress and marks it ready
 * for review; the owner closes it and the history shows every step.
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

test('a finding is raised, fixed by its owner and closed by someone else', async () => {
  const owner = await open();
  await owner.goto(`${WEB}/register`);
  await owner.getByLabel('Full name').fill('Farah Findings');
  await owner.getByLabel('Email').fill(`e2e-findings-${randomUUID()}@example.test`);
  await owner.getByLabel('Password').fill(password);
  await owner.getByRole('button', { name: 'Create account' }).click();
  await owner.waitForURL(/\/onboarding/);
  await owner.getByLabel('Organisation name').fill('E2E Findings Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = owner.url();
  const orgId = orgUrl.split('/').pop();
  const accountantEmail = `e2e-findings-acc-${randomUUID()}@example.test`;
  assert.equal((await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: accountantEmail, name: 'Ravi Remediates', password }) })).status, 201);
  assert.equal(await owner.evaluate(async ([id, email]) => (await fetch(`/api/t2t/v1/orgs/${id}/members`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ email, role: 'ACCOUNTANT' }) })).status, [orgId, accountantEmail]), 201);

  await owner.goto(`${orgUrl}/audit-findings`);
  await owner.getByText('No findings').waitFor();
  await owner.getByLabel('Finding title').fill('Petty cash not counted');
  await owner.getByLabel('What was found').fill('The petty cash box was not counted at the end of October.');
  await owner.getByLabel('Severity').selectOption('HIGH');
  await owner.getByLabel('Remediation owner').selectOption({ label: 'Ravi Remediates' });
  await owner.getByLabel('Remediation plan').fill('Count the box monthly and record it in the cash book');
  await owner.getByRole('button', { name: 'Raise finding' }).click();
  await owner.getByRole('heading', { name: 'F-001: Petty cash not counted' }).waitFor();
  assert.equal(await owner.getByRole('button', { name: 'Close finding' }).count(), 0);
  const findingUrl = owner.url();

  // The accountant fixes it.
  const accountant = await open();
  await accountant.goto(`${WEB}/login`);
  await accountant.getByLabel('Email').fill(accountantEmail);
  await accountant.getByLabel('Password').fill(password);
  await accountant.getByRole('button', { name: 'Sign in' }).click();
  await accountant.waitForURL(/\/orgs\//);
  await accountant.goto(findingUrl);
  await accountant.getByLabel('Move to').selectOption('READY_FOR_REVIEW');
  await accountant.getByLabel('What was done').fill('Counted the box and set a monthly reminder');
  await accountant.getByRole('button', { name: 'Save progress' }).click();
  await accountant.getByLabel('Finding history').getByText('Counted the box and set a monthly reminder').waitFor();
  assert.equal(await accountant.getByRole('button', { name: 'Close finding' }).count(), 0);

  // The owner closes it.
  await owner.reload();
  await owner.getByLabel('What you checked').fill('Saw the count sheet signed for October');
  await owner.getByRole('button', { name: 'Close finding' }).click();
  await owner.getByText(/^Closed by Farah Findings on /).waitFor();
  const history = owner.getByLabel('Finding history');
  for (const t of ['Raised', 'Counted the box and set a monthly reminder', 'Saw the count sheet signed for October']) await history.getByText(t).waitFor();
  await shot(owner, 'audit-finding-closed');

  await owner.getByRole('link', { name: 'All findings' }).click();
  await owner.getByRole('table', { name: 'Audit findings' }).getByRole('row', { name: /Petty cash not counted/ }).getByText('Closed').waitFor();
  await shot(owner, 'audit-findings');
  assert.deepEqual(consoleErrors, []);
});
