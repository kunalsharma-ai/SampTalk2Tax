/**
 * Browser end-to-end test for intercompany transactions: an owner of two companies sets each
 * company's intercompany accounts, posts a charge and a settlement in both companies at once,
 * sees them eliminated exactly in the consolidation, opens the posted entry, and reverses the
 * charge in both companies. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => {
  await browser?.close();
});

test('an owner posts, eliminates and reverses intercompany transactions', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('IC Owner');
  await page.getByLabel('Email').fill(`e2e-ic-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('IC Holding');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const parentId = page.url().split('/').pop();
  const sub = (await call('/v1/orgs', { name: 'IC Subsidiary', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 })).body;
  for (const o of [parentId, sub.id]) {
    for (const [code, name, type] of [['1250', 'Due from group companies', 'ASSET'], ['2160', 'Due to group companies', 'LIABILITY'], ['4300', 'Intercompany revenue', 'REVENUE'], ['6950', 'Intercompany charges', 'EXPENSE']]) {
      assert.equal((await call(`/v1/orgs/${o}/accounts`, { code, name, type })).status, 201);
    }
  }
  const G = `/v1/orgs/${parentId}/consolidation/groups`;
  const group = (await call(G, { name: 'IC group' })).body;
  assert.equal((await call(`${G}/${group.id}/members`, { orgId: sub.id })).status, 201);

  await page.goto(`${WEB}/orgs/${parentId}/consolidation/${group.id}`);
  await page.getByRole('tab', { name: 'Companies, rates and rules' }).click();
  for (const name of ['IC Holding', 'IC Subsidiary']) {
    const s = page.getByRole('region', { name: `Intercompany accounts of ${name}` });
    await s.getByLabel('Receivable from group companies').selectOption('1250');
    await s.getByLabel('Payable to group companies').selectOption('2160');
    await s.getByLabel('Revenue from group companies').selectOption('4300');
    await s.getByLabel('Expense from group companies').selectOption('6950');
    await s.getByRole('button', { name: 'Save accounts' }).click();
    await s.getByRole('button', { name: 'Save accounts' }).waitFor({ state: 'detached' });
  }

  // A charge.
  await page.getByRole('tab', { name: 'Intercompany' }).click();
  await page.getByText('No intercompany transactions yet').waitFor();
  await page.getByLabel('Company charging').selectOption(parentId);
  await page.getByLabel('Company charged').selectOption(sub.id);
  await page.getByLabel('Description', { exact: true }).fill('Management fee for October');
  await page.getByLabel('Amount (INR)').fill('45000');
  await page.getByRole('button', { name: 'Post in both companies' }).click();
  const status = page.getByRole('status').filter({ hasText: 'Posted IC-0001' });
  await status.waitFor();
  assert.match(await status.innerText(), /entry #\d+ in IC Holding and entry #\d+ in IC Subsidiary/);
  const table = page.getByRole('table', { name: 'Intercompany transactions' });
  assert.match(await table.getByRole('row').filter({ hasText: 'IC-0001' }).innerText(), /Charge[\s\S]*IC Holding[\s\S]*IC Subsidiary[\s\S]*Management fee for October[\s\S]*₹45,000\.00/);

  // A settlement through the bank accounts.
  await page.getByLabel('Type', { exact: true }).selectOption('SETTLEMENT');
  await page.getByLabel('Description', { exact: true }).fill('Part payment');
  await page.getByLabel('Amount (INR)').fill('15000');
  await page.getByLabel('Bank account receiving').selectOption('1120');
  await page.getByLabel('Bank account paying').selectOption('1120');
  await page.getByRole('button', { name: 'Post in both companies' }).click();
  await page.getByRole('status').filter({ hasText: 'Posted IC-0002' }).waitFor();

  // Eliminated exactly in the consolidation.
  await page.getByRole('tab', { name: 'Worksheet' }).click();
  const el = page.getByRole('list', { name: 'Eliminations' });
  const bal = el.getByRole('listitem').filter({ hasText: 'Intercompany balance: IC Subsidiary owes IC Holding' });
  await bal.waitFor();
  assert.match(await bal.innerText(), /From intercompany transactions[\s\S]*Agrees[\s\S]*₹30,000\.00[\s\S]*-₹30,000\.00/);
  assert.match(await el.getByRole('listitem').filter({ hasText: 'Intercompany charges: IC Holding to IC Subsidiary' }).innerText(), /Agrees/);
  const ws = page.getByRole('table', { name: 'Consolidation worksheet' });
  assert.match(await ws.getByRole('row').filter({ hasText: 'Due from group companies' }).innerText(), /^1250 Due from group companies\s+₹30,000\.00\s+—\s+-₹30,000\.00\s+—$/);

  // The posted entry explains where it came from.
  await page.getByRole('tab', { name: 'Intercompany' }).click();
  await table.getByRole('row').filter({ hasText: 'IC-0001' }).getByRole('link', { name: /^To #\d+$/ }).click();
  await page.getByText('Created by an intercompany transaction (IC-0001)').waitFor();
  await page.goBack();

  // Reverse the charge in both companies.
  await page.getByRole('tab', { name: 'Intercompany' }).click();
  await page.getByRole('button', { name: 'Reverse IC-0001' }).click();
  await table.getByRole('row').filter({ hasText: 'IC-0001' }).getByText(/^Reversed /).waitFor();
  assert.match(await table.getByRole('row').filter({ hasText: 'IC-0001' }).innerText(), /Reversals: From #\d+ · To #\d+/);
  const tb = (await call(`/v1/orgs/${sub.id}/reports/trial-balance?asOf=${new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)}`)).body;
  const payable = tb.rows.find((r) => r.code === '2160');
  assert.equal(Number(payable.netDebit) - Number(payable.netCredit), 15000);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
