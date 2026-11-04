/**
 * Browser end-to-end test for alerts: an owner records a bill and a payment twice, opens
 * Alerts (the checks run by themselves), reads the evidence, dismisses one alert with a
 * reason, acknowledges another, fixes its cause and sees it clear, and changes a check's
 * settings. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, orgId, base, accounts;
const ids = {};
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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

test('the checks find a repeated bill and payment, and each alert can be dismissed, acknowledged and cleared', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Alert Owner');
  await page.getByLabel('Email').fill(`e2e-alerts-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Watchful Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const fy = +T.slice(0, 4) + (+T.slice(5, 7) >= 4 ? 1 : 0);
  const have = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!have.has(fy - 1)) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fy - 1 })).status, 201);
  const vendor = (await call(`${base}/contacts`, { name: 'Cedar Hardware', isVendor: true })).body;
  assert.equal((await call(`${base}/journals`, { date: addDays(T, -20), post: true, memo: 'Capital', lines: [{ accountId: accounts['1120'], debit: '300000.00' }, { accountId: accounts['3100'], credit: '300000.00' }] })).status, 201);
  for (const [k, d, ref] of [['bill1', -4, 'CH-881'], ['bill2', -2, 'CH-882']]) {
    const r = await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: addDays(T, d), reference: ref, post: true, lines: [{ accountId: accounts['6400'], quantity: '1', unitPrice: '23600.00' }] });
    assert.equal(r.status, 201);
    ids[k] = r.body;
  }
  for (const [k, d] of [['pay1', -2], ['pay2', -1]]) {
    const r = await call(`${base}/purchases/payments`, { contactId: vendor.id, date: addDays(T, d), bankAccountId: accounts['1120'], amount: '7500.00', reference: `UTR-${k}` });
    assert.equal(r.status, 201);
    ids[k] = r.body;
  }

  // The dashboard ran the checks by itself when the organisation was new and empty; the
  // records above came after, so run them again.
  await page.getByRole('link', { name: 'Alerts', exact: true }).click();
  await page.getByRole('heading', { name: 'Alerts', exact: true }).waitFor();
  await page.getByText(/Last checked just now \(automatically\) · 9 checks ran · 0 found/).waitFor();
  await page.getByRole('button', { name: 'Run checks now' }).click();
  await page.getByText(/Checks finished just now by Alert Owner · 9 checks ran · 2 found · 2 new, 0 back, 0 cleared/).waitFor();
  const billRow = page.getByRole('button', { name: 'Warning: Possible duplicate bill: 2 bills to Cedar Hardware for ₹23,600' });
  const payRow = page.getByRole('button', { name: 'Critical: Possible duplicate payment: 2 payments to Cedar Hardware for ₹7,500' });
  await billRow.waitFor();
  await payRow.waitFor();

  // The evidence, and a dismissal that needs a reason.
  await billRow.click();
  let dlg = page.getByRole('dialog');
  await dlg.getByRole('row', { name: new RegExp(`${ids.bill1.number} .* CH-881 ₹23,600$`) }).waitFor();
  await dlg.getByRole('link', { name: ids.bill2.number }).waitFor();
  assert.equal(await dlg.getByRole('link', { name: ids.bill2.number }).getAttribute('href'), `/orgs/${orgId}/purchases/bills/${ids.bill2.id}`);
  await dlg.getByText('Found · Alert Owner', { exact: false }).waitFor();
  await dlg.getByRole('button', { name: 'Dismiss…' }).click();
  await dlg.getByLabel('Why is this not a problem?').fill('ok');
  await dlg.getByText('At least 3 characters').waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Dismiss alert' }).isDisabled(), true);
  await dlg.getByLabel('Why is this not a problem?').fill('Two deliveries of the same order size, both received');
  await dlg.getByRole('button', { name: 'Dismiss alert' }).click();
  await dlg.getByText('Dismissed by Alert Owner: Two deliveries of the same order size, both received').waitFor();
  await page.keyboard.press('Escape');
  await billRow.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Dismissed' }).click();
  await billRow.waitFor();

  // Acknowledge the payment alert, then fix its cause.
  await page.getByRole('tab', { name: /Needs attention/ }).click();
  await payRow.click();
  dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Acknowledge' }).click();
  await dlg.getByLabel('Note (optional)').fill('Asked Cedar to refund the second transfer');
  await dlg.getByRole('button', { name: 'Acknowledge' }).click();
  await dlg.getByText('Note by Alert Owner: Asked Cedar to refund the second transfer').waitFor();
  await page.keyboard.press('Escape');
  await payRow.getByText('Acknowledged').waitFor();

  assert.equal((await call(`${base}/purchases/payments/${ids.pay2.id}/void`, { reason: 'Refunded by Cedar' })).status, 200);
  await page.getByRole('button', { name: 'Run checks now' }).click();
  await page.getByText(/Checks finished just now by Alert Owner .* 0 new, 0 back, 1 cleared/).waitFor();
  await payRow.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Cleared' }).click();
  await payRow.click();
  dlg = page.getByRole('dialog');
  await dlg.getByText('No longer found by the checks').waitFor();
  await dlg.getByText('The checks no longer find this. It comes back by itself if they do.').waitFor();
  const history = await dlg.getByRole('region', { name: 'History' }).getByRole('listitem').allInnerTexts();
  assert.deepEqual(history.map((h) => h.split(' · ')[0]), ['Found', 'Acknowledged', 'Cleared']);
  await page.keyboard.press('Escape');

  // Settings: an out-of-range value is caught in the page; a valid one is saved.
  await page.getByRole('link', { name: 'Check settings' }).click();
  const card = page.getByLabel('Possible duplicate bill', { exact: true });
  await card.getByLabel('Within (days)').fill('500');
  await card.getByText('From 0 to 90').waitFor();
  assert.equal(await card.getByRole('button', { name: 'Save' }).isDisabled(), true);
  await card.getByLabel('Within (days)').fill('14');
  await card.getByRole('button', { name: 'Save' }).click();
  await card.getByText(/Changed .* by Alert Owner/).waitFor();
  const rules = (await call(`${base}/alert-rules`)).body;
  assert.deepEqual(rules.find((r) => r.key === 'DUPLICATE_BILL').values, { windowDays: '14' });

  // The dashboard shows what still needs attention; the dismissed bill stays dismissed.
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.getByRole('heading', { name: 'Alerts', exact: true }).waitFor();
  const list = (await call(`${base}/alerts?status=ALL`)).body;
  assert.equal(list.alerts.find((a) => a.rule === 'DUPLICATE_BILL').status, 'DISMISSED');
  assert.equal(list.alerts.find((a) => a.rule === 'DUPLICATE_PAYMENT').status, 'CLEARED');
  assert.deepEqual(consoleErrors, []);
});
