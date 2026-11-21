/**
 * Browser end-to-end test for the external auditor portal (AUDIT-002): the owner gives an external
 * auditor read-only access to an engagement; the auditor opens the link without signing in, sees
 * the work, the accepted evidence and the trial balance, and downloads an evidence file; once the
 * owner withdraws the link it no longer opens.
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
const PDF = '%PDF-1.4\n% lease agreement\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
let browser;
const consoleErrors = [];
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);
const open = async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  return page;
};
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify(body) });

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

test('an external auditor opens a read-only link until it is withdrawn', async () => {
  const owner = await open();
  await owner.goto(`${WEB}/register`);
  await owner.getByLabel('Full name').fill('Omkar Owner');
  await owner.getByLabel('Email').fill(`e2e-auditor-portal-${randomUUID()}@example.test`);
  await owner.getByLabel('Password').fill(password);
  await owner.getByRole('button', { name: 'Create account' }).click();
  await owner.waitForURL(/\/onboarding/);
  await owner.getByLabel('Organisation name').fill('E2E Auditor Portal Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = owner.url();
  const orgId = orgUrl.split('/').pop();
  const reviewerEmail = `e2e-auditor-portal-rev-${randomUUID()}@example.test`;
  const reg = await (await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: reviewerEmail, name: 'Rhea Reviewer', password }) })).json();
  assert.equal(await owner.evaluate(async ([id, email]) => (await fetch(`/api/t2t/v1/orgs/${id}/members`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ email, role: 'APPROVER' }) })).status, [orgId, reviewerEmail]), 201);

  // An engagement led by the owner, with accepted evidence.
  const ids = await owner.evaluate(
    async ([id, reviewerId, pdf, json]) => {
      const call = async (path, method, body) => (await fetch(`/api/t2t/v1/orgs/${id}${path}`, { method, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: body ? JSON.stringify(body) : undefined })).json();
      const me = (await (await fetch('/api/t2t/v1/auth/me')).json()).user.id;
      const day = new Date().toISOString().slice(0, 10);
      const e = await call('/audit-engagements', 'POST', { name: 'Lease audit', objective: 'Check the office lease is recorded correctly', scopeFrom: day, scopeTo: day, leadId: me, reviewerId });
      await call(`/audit-engagements/${e.id}/steps`, 'POST', { title: 'Read the lease agreement', assigneeId: me });
      await call(`/audit-engagements/${e.id}/move`, 'POST', { status: 'FIELDWORK', note: '' });
      const r = await call('/audit-evidence', 'POST', { engagementId: e.id, title: 'Signed lease', details: '', ownerId: me, dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) });
      await fetch(`/api/t2t/v1/orgs/${id}/attachments?entityType=AUDIT_EVIDENCE&entityId=${r.id}&fileName=lease.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t2t-csrf': '1' }, body: new TextEncoder().encode(pdf) });
      await call(`/audit-evidence/${r.id}/submit`, 'POST', { note: '' });
      return { engagementId: e.id, requestId: r.id };
    },
    [orgId, reg.user.id, PDF],
  );
  const accepted = await fetch(`${API}/v1/orgs/${orgId}/audit-evidence/${ids.requestId}/review`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.accessToken}` }, body: JSON.stringify({ decision: 'ACCEPT', note: 'Signed by both parties' }) });
  assert.equal(accepted.status, 201, await accepted.clone().text());

  // The owner gives the auditor access.
  await owner.goto(`${orgUrl}/audit-engagements/${ids.engagementId}`);
  await owner.getByText('No external auditor has access.').waitFor();
  await owner.getByRole('button', { name: 'Give auditor access' }).click();
  await owner.getByLabel("Auditor's name").fill('Anita Auditor');
  await owner.getByLabel('Firm').fill('Anita & Associates');
  await owner.getByLabel('Works for').selectOption('7');
  await owner.getByRole('button', { name: 'Make link' }).click();
  const link = await owner.getByLabel('Auditor link', { exact: true }).inputValue();
  assert.match(link, /\/auditor-portal\/t2ta_[A-Za-z0-9]{40}$/);
  await owner.getByRole('button', { name: 'Done' }).click();
  await owner.getByRole('table', { name: 'Auditor links' }).getByText('Anita Auditor').waitFor();

  // The auditor opens it, signed out.
  const auditor = await open();
  await auditor.goto(link);
  await auditor.getByRole('heading', { name: 'IA-001: Lease audit' }).waitFor();
  await auditor.getByText('Anita Auditor, Anita & Associates').waitFor();
  await auditor.getByRole('table', { name: 'Work performed' }).getByText('Read the lease agreement').waitFor();
  await auditor.getByRole('table', { name: 'Trial balance' }).getByText('Total').waitFor();
  const download = auditor.waitForEvent('download');
  await auditor.getByRole('link', { name: 'lease.pdf' }).click();
  assert.equal((await download).suggestedFilename(), 'lease.pdf');
  await shot(auditor, 'auditor-portal');

  // Withdrawn, it no longer opens.
  await owner.reload();
  await owner.getByRole('table', { name: 'Auditor links' }).getByText(/1 time, 1 file/).waitFor();
  await owner.getByRole('button', { name: 'Withdraw' }).click();
  await owner.getByRole('table', { name: 'Auditor links' }).getByText('Withdrawn').waitFor();
  await shot(owner, 'auditor-links');
  await auditor.reload();
  await auditor.getByText('E2E Auditor Portal Co has withdrawn this link.').waitFor();
  assert.deepEqual(consoleErrors.filter((m) => !m.includes('404')), []);
});
