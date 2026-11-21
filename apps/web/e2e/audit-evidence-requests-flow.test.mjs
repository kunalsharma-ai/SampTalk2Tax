/**
 * Browser end-to-end test for audit evidence management (AUDIT-003): the audit lead asks a member
 * for evidence from the engagement; the member finds it under Waiting for me, attaches a file and
 * submits it; the reviewer accepts it and the files show with their SHA-256.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.T2T_API_URL ?? 'http://localhost:4000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const password = 'e2e-very-long-password';
const PDF = Buffer.from('%PDF-1.4\n% bank statement\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let browser;
const consoleErrors = [];
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);
const open = async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  return page;
};
const signIn = async (email) => {
  const page = await open();
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/orgs\//);
  return page;
};

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

test('evidence is asked for, submitted with a file and accepted', async () => {
  const owner = await open();
  await owner.goto(`${WEB}/register`);
  await owner.getByLabel('Full name').fill('Revati Reviewer');
  await owner.getByLabel('Email').fill(`e2e-evidence-${randomUUID()}@example.test`);
  await owner.getByLabel('Password').fill(password);
  await owner.getByRole('button', { name: 'Create account' }).click();
  await owner.waitForURL(/\/onboarding/);
  await owner.getByLabel('Organisation name').fill('E2E Evidence Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = owner.url();
  const orgId = orgUrl.split('/').pop();
  const people = {};
  for (const [key, name] of [['lead', 'Lakshmi Lead'], ['staff', 'Sameer Staff']]) {
    const email = `e2e-evidence-${key}-${randomUUID()}@example.test`;
    const res = await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name, password }) });
    assert.equal(res.status, 201);
    people[key] = { email, id: (await res.json()).user.id };
    assert.equal(await owner.evaluate(async ([id, e]) => (await fetch(`/api/t2t/v1/orgs/${id}/members`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ email: e, role: 'ACCOUNTANT' }) })).status, [orgId, email]), 201);
  }
  const ownerId = await owner.evaluate(async () => (await (await fetch('/api/t2t/v1/auth/me')).json()).user.id);
  const engagement = await owner.evaluate(
    async ([id, leadId, reviewerId]) => (await fetch(`/api/t2t/v1/orgs/${id}/audit-engagements`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ name: 'Bank audit', objective: 'Check bank balances are supported by statements', scopeFrom: new Date().toISOString().slice(0, 10), scopeTo: new Date().toISOString().slice(0, 10), leadId, reviewerId }) })).json(),
    [orgId, people.lead.id, ownerId],
  );
  assert.equal(engagement.reference, 'IA-001');

  // The lead asks the staff member for evidence.
  const lead = await signIn(people.lead.email);
  await lead.goto(`${orgUrl}/audit-engagements/${engagement.id}`);
  await lead.getByText('No evidence asked for').waitFor();
  await lead.getByLabel('Evidence needed').fill('October bank statement');
  await lead.getByLabel('Details').fill('The signed statement for the main account');
  await lead.getByLabel('Ask', { exact: true }).selectOption({ label: 'Sameer Staff' });
  await lead.getByLabel('Due by').fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  await lead.getByRole('button', { name: 'Ask for evidence' }).click();
  await lead.getByRole('table', { name: 'Evidence asked for' }).getByText('Requested').waitFor();

  // The staff member submits it.
  const staff = await signIn(people.staff.email);
  await staff.goto(`${orgUrl}/audit-evidence`);
  await staff.getByLabel('Show').selectOption('MINE');
  await staff.getByRole('link', { name: 'October bank statement' }).click();
  await staff.getByRole('heading', { name: 'ER-001: October bank statement' }).waitFor();
  await staff.getByLabel('Attach files').setInputFiles({ name: 'october statement.pdf', mimeType: 'application/pdf', buffer: PDF });
  await staff.getByText('october statement.pdf').first().waitFor();
  await staff.getByLabel('Note for the auditor').fill('Signed by the bank');
  await staff.getByRole('button', { name: 'Submit evidence' }).click();
  await staff.getByRole('table', { name: 'Files submitted' }).getByText(createHash('sha256').update(PDF).digest('hex')).waitFor();
  assert.equal(await staff.getByRole('button', { name: 'Accept evidence' }).count(), 0);

  // The reviewer accepts it.
  await owner.goto(`${orgUrl}/audit-evidence`);
  await owner.getByRole('link', { name: 'October bank statement' }).click();
  await owner.getByLabel('What you checked, or what is missing').fill('Agrees to the ledger balance');
  await owner.getByRole('button', { name: 'Accept evidence' }).click();
  await owner.getByText(/^Accepted by Revati Reviewer on /).waitFor();
  const history = owner.getByRole('table', { name: 'Evidence history' });
  for (const t of ['Requested', 'Submitted', 'Accepted']) await history.getByRole('cell', { name: new RegExp(`^${t}`) }).first().waitFor();
  await shot(owner, 'audit-evidence-request');

  await owner.getByRole('link', { name: 'All evidence' }).click();
  await owner.getByRole('table', { name: 'Evidence requests' }).getByRole('row', { name: /October bank statement/ }).getByText('Accepted').waitFor();
  await shot(owner, 'audit-evidence');
  assert.deepEqual(consoleErrors, []);
});
