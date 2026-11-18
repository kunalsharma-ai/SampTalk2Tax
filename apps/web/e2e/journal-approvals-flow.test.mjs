/**
 * Browser end-to-end test for approval of manual journals (SEC-036): the owner sets the amount on
 * Approval rules; an accountant drafts a large journal, cannot post it, and asks for approval; the
 * owner sees it on Approvals and approves it on the journal; the accountant posts it. Real
 * Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, owner, accountant;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);

async function call(p, path, body, method = body ? 'POST' : 'GET') {
  return p.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

async function register(p, name, email) {
  await p.goto(`${WEB}/register`);
  await p.getByLabel('Full name').fill(name);
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill('e2e-very-long-password');
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.waitForURL(/\/onboarding/);
}

before(async () => {
  browser = await chromium.launch();
  owner = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  accountant = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, accountant]) p.on('console', (m) => m.type() === 'error' && !/status of 409/.test(m.text()) && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a large manual journal posts only after someone else approves it', async () => {
  const accEmail = `e2e-ja-acc-${randomUUID()}@example.test`;
  await register(accountant, 'Asha Accountant', accEmail);
  await register(owner, 'Olu Owner', `e2e-ja-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Journal Approvals Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  assert.equal((await call(owner, `${base}/members`, { email: accEmail, role: 'ACCOUNTANT' })).status, 201);

  await owner.goto(`${WEB}/orgs/${orgId}/settings/approvals`);
  await owner.getByText('No approval needed for manual journals.').waitFor();
  await owner.getByText('No approval needed for manual journals.').locator('..').getByRole('button', { name: 'Edit' }).click();
  await owner.getByLabel('For journals of at least').fill('50000');
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await owner.getByText(/Needs approval from/).waitFor();

  await accountant.goto(`${WEB}/orgs/${orgId}`);
  const acc = Object.fromEntries((await call(accountant, `${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const draft = await call(accountant, `${base}/journals`, { date: T, memo: 'Quarterly rent', post: false, lines: [{ accountId: acc['6200'], debit: '60000.00' }, { accountId: acc['1120'], credit: '60000.00' }] });
  assert.equal(draft.status, 201);
  const entryId = draft.body.id;
  await accountant.goto(`${WEB}/orgs/${orgId}/journals/${entryId}`);
  await accountant.getByRole('button', { name: 'Post', exact: true }).click();
  await accountant.getByText(/needs someone else's approval before it posts/).waitFor();
  await accountant.getByLabel('Note for the approver (optional)').fill('Lease for Q4');
  await accountant.getByRole('button', { name: 'Ask for approval' }).click();
  await accountant.getByText('Waiting for approval').first().waitFor();
  await shot(accountant, 'journal-approval-asked');

  await owner.getByRole('link', { name: 'Approvals', exact: true }).click();
  const inbox = owner.getByRole('table', { name: 'Manual journals to approve' });
  await inbox.getByText('Lease for Q4').waitFor();
  await inbox.getByRole('link', { name: 'Review' }).click();
  await owner.waitForURL(/\/journals\//);
  await owner.getByLabel('Decision note').fill('Agreed to the lease');
  await owner.getByRole('button', { name: 'Approve', exact: true }).click();
  await owner.getByText('Approved: it can now be posted.').waitFor();
  await shot(owner, 'journal-approval-approved');

  await accountant.reload();
  await accountant.getByText('Approved: it can now be posted.').waitFor();
  await accountant.getByRole('button', { name: 'Post', exact: true }).click();
  await accountant.getByText('Posted', { exact: true }).waitFor();
  assert.deepEqual(consoleErrors, []);
});
