/**
 * Browser end-to-end test for the customer portal (AR-030): on a customer's page a portal link is
 * made and copied, the customer opens it in a browser with no session and sees what they owe,
 * their invoices (not drafts, not other customers'), payments and statement, and can open an
 * invoice; once the link is revoked the portal refuses it.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
let browser, page;
const consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a customer sees their account through a private portal link', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Portal Owner');
  await page.getByLabel('Email').fill(`e2e-portal-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Portal Consulting');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const cust = (await call(`${B}/contacts`, { name: 'Tapti Textiles', isCustomer: true })).body;
  const other = (await call(`${B}/contacts`, { name: 'Narmada Mills', isCustomer: true })).body;
  const inv = async (contactId, amount, issueDate, post = true) => {
    const d = (await call(`${B}/sales/documents`, { kind: 'INVOICE', contactId, issueDate, dueDate: addDays(issueDate, 10), lines: [{ accountId: acc['4100'], description: 'Design retainer', quantity: '1', unitPrice: amount }] })).body;
    return post ? (await call(`${B}/sales/documents/${d.id}/post`, {})).body : d;
  };
  const old = await inv(cust.id, '25000.00', addDays(T, -30));
  const fresh = await inv(cust.id, '8000.00', T);
  await inv(cust.id, '111.00', T, false);
  await inv(other.id, '9999.00', T);
  const rec = await call(`${B}/sales/payments`, { contactId: cust.id, date: T, bankAccountId: acc['1120'], amount: '15000.00', reference: 'UTR 5541', allocations: [{ documentId: old.id, amount: '15000.00' }] });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));

  // Staff make a link on the customer's page.
  await page.goto(`${WEB}/orgs/${orgId}/sales/customers/${cust.id}`);
  const card = page.locator('[aria-label="Customer portal"]');
  await card.getByText('No portal links yet.').waitFor();
  await card.getByRole('button', { name: 'Make portal link' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Works for').selectOption('30');
  await dlg.getByLabel('Note').fill('Emailed to accounts team');
  await dlg.getByRole('button', { name: 'Make link' }).click();
  const link = await dlg.getByLabel('Portal link').inputValue();
  assert.match(link, /\/portal\/t2tp_[A-Za-z0-9]{40}$/);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await card.getByText('Emailed to accounts team').waitFor();
  await card.getByText('Not yet').waitFor();

  // The customer opens it with no session at all.
  const outside = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cp = await outside.newPage();
  cp.on('console', (m) => m.type() === 'error' && consoleErrors.push(`portal: ${m.text()}`));
  await cp.goto(link);
  await cp.getByRole('heading', { name: 'E2E Portal Consulting' }).waitFor();
  assert.equal(new URL(cp.url()).pathname.startsWith('/portal/'), true);
  const owe = cp.locator('[aria-label="What you owe"]');
  assert.match(await owe.innerText(), /Balance to pay[\s\S]*18,000\.00[\s\S]*Overdue[\s\S]*10,000\.00/);
  const invoices = cp.locator('[aria-label="Your invoices"]');
  const text = await invoices.innerText();
  assert.match(text, new RegExp(`${old.number}[\\s\\S]*25,000\\.00[\\s\\S]*10,000\\.00[\\s\\S]*Overdue`));
  assert.match(text, new RegExp(`${fresh.number}[\\s\\S]*8,000\\.00[\\s\\S]*To pay`));
  assert.doesNotMatch(text, /111\.00|9,999|Narmada/);
  await cp.locator('[aria-label="Payments received"]').getByText('UTR 5541').waitFor();
  const st = cp.locator('[aria-label="Statement lines"]');
  await st.getByText('Opening balance').waitFor();
  assert.match(await st.innerText(), /Payment received[\s\S]*18,000\.00/);
  const [doc] = await Promise.all([cp.waitForEvent('popup'), invoices.getByRole('link', { name: old.number }).click()]);
  await doc.waitForLoadState();
  assert.match(await doc.content(), /Tapti Textiles/);
  await doc.close();

  // Staff see it was opened, then revoke it.
  await page.reload();
  await card.getByText(/^1 time/).waitFor();
  page.once('dialog', (d) => d.accept());
  await card.getByRole('button', { name: 'Revoke' }).click();
  await card.getByText('Revoked', { exact: true }).waitFor();
  await cp.reload();
  await cp.getByText('E2E Portal Consulting has withdrawn this link. Ask them for a new one.').waitFor();
  await outside.close();

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
