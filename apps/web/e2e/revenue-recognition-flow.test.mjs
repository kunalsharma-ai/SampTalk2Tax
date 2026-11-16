/**
 * Browser end-to-end test for revenue recognition (AR-028): on a draft invoice a line is set to be
 * recognised over twelve months from the invoice page, the invoice posts to deferred revenue, the
 * monthly release run recognises the first month, the Revenue recognition page shows the deferred
 * revenue account, the waterfall and the line, and voiding the invoice ends the schedule.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addMonth = (ym, n) => {
  const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const M = T.slice(0, 7);
const M1 = addMonth(M, -1);
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

test('an invoice line is recognised over its service period', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Recognition Owner');
  await page.getByLabel('Email').fill(`e2e-revrec-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Subscription Software');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${B}/contacts`, { name: 'Kaveri Analytics', isCustomer: true })).body;
  const inv = await call(`${B}/sales/documents`, {
    kind: 'INVOICE',
    contactId: customer.id,
    issueDate: `${M1}-01`,
    lines: [
      { accountId: acc['4100'], description: 'Annual analytics subscription', quantity: '1', unitPrice: '120000.00' },
      { accountId: acc['4200'], description: 'Onboarding', quantity: '1', unitPrice: '5000.00' },
    ],
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));

  // On the draft: line 1 over twelve months, evenly.
  await page.goto(`${WEB}/orgs/${orgId}/sales/invoices/${inv.body.id}`);
  const card = page.locator('[aria-label="Revenue recognition"]');
  await card.getByLabel('Recognise line 1 over time').check();
  await card.getByLabel('Line 1 service start').fill(`${M1}-01`);
  await card.getByLabel('Line 1 months').fill('12');
  await card.getByLabel('Line 1 spread').selectOption('EVEN');
  await card.getByRole('button', { name: 'Save recognition' }).click();
  await card.getByText('The recognition terms are kept with the draft').waitFor();
  assert.equal(await card.getByLabel('Line 2 months').isDisabled(), true);

  // Post it: line 1 goes to deferred revenue with a schedule.
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await card.getByRole('link', { name: 'DR-0001' }).waitFor();
  const progress = card.locator('[aria-label="Recognition progress"]');
  assert.match(await progress.innerText(), /Annual analytics subscription[\s\S]*12 months, evenly[\s\S]*1,20,000\.00/);
  const posted = (await call(`${B}/sales/documents/${inv.body.id}`)).body;
  const je = (await call(`${B}/journals/${posted.journalEntryId}`)).body;
  const credit = (id) => je.lines.filter((l) => l.accountId === id).reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
  assert.equal(credit(acc['2350']), 120000);
  assert.equal(credit(acc['4100']), 0);
  assert.equal(credit(acc['4200']), 5000);

  // The release run recognises the first month.
  const run = await call(`${B}/deferrals/releases/runs`, { month: M1 });
  assert.equal(run.status, 201, JSON.stringify(run.body));

  await page.goto(`${WEB}/orgs/${orgId}/sales/revenue-recognition`);
  await page.getByText('Using the standard account 2350').waitFor();
  const lines = page.locator('[aria-label="Invoice lines"]');
  await lines.getByRole('link', { name: posted.number }).waitFor();
  assert.match(await lines.innerText(), /Kaveri Analytics[\s\S]*DR-0001[\s\S]*1,20,000\.00[\s\S]*10,000\.00[\s\S]*1,10,000\.00/);
  await page.getByLabel('From month').fill(M1);
  const fall = page.locator('[aria-label="Waterfall"]');
  await fall.locator('tr', { hasText: 'All schedules' }).getByText('1,20,000.00').waitFor();
  const rows = await fall.locator('tbody tr').allInnerTexts();
  assert.equal(rows.length, 14);
  assert.match(rows[1], /10,000\.00/);
  assert.match(rows[12], /10,000\.00/);
  assert.match(rows[13], /After[\s\S]*0\.00/);

  // Voiding takes back what was recognised and ends the schedule.
  const v = await call(`${B}/sales/documents/${inv.body.id}/void`, { date: T, reason: 'Subscription cancelled' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  await page.goto(`${WEB}/orgs/${orgId}/sales/invoices/${inv.body.id}`);
  await card.getByText(/^Ended/).waitFor();
  assert.match(await progress.innerText(), /DR-0001[\s\S]*1,20,000\.00[\s\S]*10,000\.00[\s\S]*0\.00/);

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
