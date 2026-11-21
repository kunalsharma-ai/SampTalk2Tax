/**
 * Browser end-to-end test for document versioning (AUDIT-007): a file attached to a journal is
 * replaced by a signed copy; the list shows the new version, and its history keeps the earlier
 * one, which still opens.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const password = 'e2e-very-long-password';
const pdf = (text) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
let browser;
const consoleErrors = [];
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

test('a new version replaces a file and the earlier one stays in its history', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Vera Versions');
  await page.getByLabel('Email').fill(`e2e-versions-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Versions Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const orgId = orgUrl.split('/').pop();
  const journalId = await page.evaluate(async (id) => {
    const accounts = await (await fetch(`/api/t2t/v1/orgs/${id}/accounts`)).json();
    const acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const day = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const r = await fetch(`/api/t2t/v1/orgs/${id}/journals`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ date: day, post: true, memo: 'Office rent', lines: [{ accountId: acc['6200'], debit: '5000' }, { accountId: acc['1120'], credit: '5000' }] }) });
    return (await r.json()).id;
  }, orgId);

  await page.goto(`${orgUrl}/journals/${journalId}`);
  await page.getByLabel('Attach files').setInputFiles({ name: 'rent-agreement.pdf', mimeType: 'application/pdf', buffer: pdf('draft') });
  const files = page.getByLabel('Attached files');
  await files.getByRole('link', { name: 'rent-agreement.pdf' }).waitFor();

  await files.getByRole('button', { name: 'New version…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New file').setInputFiles({ name: 'rent-agreement-signed.pdf', mimeType: 'application/pdf', buffer: pdf('signed') });
  await dialog.getByLabel('What changed').fill('Signed by both parties');
  await dialog.getByRole('button', { name: 'Upload version' }).click();
  await files.getByRole('link', { name: 'rent-agreement-signed.pdf' }).waitFor();
  assert.equal(await files.getByRole('link', { name: 'rent-agreement.pdf', exact: true }).count(), 0);
  await files.getByText(/version 2: Signed by both parties/).waitFor();

  await files.getByRole('button', { name: 'Versions' }).click();
  const history = page.getByLabel('Versions of rent-agreement-signed.pdf');
  await history.getByText('Version 2').waitFor();
  const old = history.getByRole('link', { name: 'rent-agreement.pdf' });
  await old.waitFor();
  await shot(page, 'document-versions');
  const res = await page.request.get(new URL(await old.getAttribute('href'), WEB).href);
  assert.equal(res.status(), 200);
  assert.match((await res.body()).toString(), /% draft/);
  assert.deepEqual(consoleErrors, []);
});
