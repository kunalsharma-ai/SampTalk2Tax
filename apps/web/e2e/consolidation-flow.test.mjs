/**
 * Browser end-to-end test for group consolidation: an owner of two companies creates a group in
 * the parent, adds the subsidiary, adds an elimination rule by picking each company's account,
 * reads the worksheet and the consolidated statements, sees an intercompany difference, and
 * exports the worksheet, then marks the subsidiary as 60% owned and sees non-controlling interests.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
});

test('an owner consolidates two companies with an elimination', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Group Owner');
  await page.getByLabel('Email').fill(`e2e-group-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Holding');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const parentId = page.url().split('/').pop();
  const sub = (await call('/v1/orgs', { name: 'E2E Subsidiary', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 })).body;
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const setup = async (orgId, accounts, journals) => {
    const acc = Object.fromEntries((await call(`/v1/orgs/${orgId}/accounts`)).body.map((a) => [a.code, a.id]));
    for (const [code, name, type] of accounts) acc[code] = (await call(`/v1/orgs/${orgId}/accounts`, { code, name, type })).body.id;
    for (const [d, c, amount] of journals) {
      assert.equal((await call(`/v1/orgs/${orgId}/journals`, { date: today, post: true, memo: 'E2E', lines: [{ accountId: acc[d], debit: amount }, { accountId: acc[c], credit: amount }] })).status, 201);
    }
  };
  await setup(parentId, [['1250', 'Due from group companies', 'ASSET']], [['1120', '3100', '100000.00'], ['1250', '4100', '40000.00']]);
  await setup(sub.id, [['2160', 'Due to group companies', 'LIABILITY']], [['1120', '3100', '50000.00'], ['6100', '2160', '40000.00']]);

  await page.getByRole('link', { name: 'Group consolidation', exact: true }).click();
  await page.getByText('No groups yet').waitFor();
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('Group name').fill('E2E group');
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.waitForURL(/consolidation\/[0-9a-f-]{36}$/);

  // Companies and a rule.
  await page.getByRole('tab', { name: 'Companies, rates and rules' }).click();
  await page.getByLabel('Add a company').selectOption(sub.id);
  await page.getByRole('button', { name: 'Add to group' }).click();
  const members = page.getByRole('table', { name: 'Companies in the group' });
  await members.getByText('E2E Subsidiary').waitFor();
  await page.getByText('Every company keeps its books in INR; no rates are needed.').waitFor();
  await page.getByLabel('Rule name').fill('Current account');
  await page.getByLabel('First company').selectOption(parentId);
  await page.getByLabel('First account').selectOption('1250');
  await page.getByLabel('Second company').selectOption(sub.id);
  await page.getByLabel('Second account').selectOption('2160');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('list', { name: 'Elimination rules' }).getByText('Current account').waitFor();

  // Worksheet: the current account is eliminated and every column totals zero.
  await page.getByRole('tab', { name: 'Worksheet' }).click();
  const ws = page.getByRole('table', { name: 'Consolidation worksheet' });
  await ws.waitFor();
  const row1250 = ws.getByRole('row').filter({ hasText: 'Due from group companies' });
  assert.match(await row1250.innerText(), /40,000\.00[\s\S]*-₹40,000\.00/);
  await page.getByRole('list', { name: 'Eliminations' }).getByText('Agrees').waitFor();
  assert.match(await ws.locator('tfoot').innerText(), /^Total\s+0\.00\s+0\.00\s+0\.00\s+0\.00$/);

  // Statements.
  await page.getByRole('tab', { name: 'Profit and loss' }).click();
  const is = await page.getByRole('table', { name: 'Consolidated profit and loss' }).innerText();
  assert.match(is, /Total revenue\s+₹40,000\.00/);
  assert.match(is, /Group net profit\s+₹0\.00/);
  await page.getByRole('tab', { name: 'Balance sheet' }).click();
  const bs = await page.getByRole('table', { name: 'Consolidated balance sheet' }).innerText();
  assert.match(bs, /Total assets\s+₹1,50,000\.00/);
  assert.match(bs, /Total liabilities and equity\s+₹1,50,000\.00/);
  assert.doesNotMatch(bs, /Due from group companies/);

  // A one-sided booking shows up as a difference.
  const subAcc = Object.fromEntries((await call(`/v1/orgs/${sub.id}/accounts`)).body.map((a) => [a.code, a.id]));
  await call(`/v1/orgs/${sub.id}/journals`, { date: today, post: true, memo: 'E2E extra', lines: [{ accountId: subAcc['6100'], debit: '500.00' }, { accountId: subAcc['2160'], credit: '500.00' }] });
  await page.getByRole('tab', { name: 'Worksheet' }).click();
  await page.reload();
  await page.getByRole('list', { name: 'Eliminations' }).getByText('Difference').first().waitFor();
  assert.match(await ws.getByRole('row').filter({ hasText: 'Intercompany differences to resolve' }).innerText(), /-₹500\.00/);

  // Export the worksheet as CSV.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export as CSV' }).click()]);
  const path = join(tmpdir(), `${randomUUID()}.csv`);
  await dl.saveAs(path);
  const csv = readFileSync(path, 'utf8');
  assert.match(dl.suggestedFilename(), /^e2e-group-consolidation-worksheet-/);
  assert.match(csv, /Code,Account,E2E Holding,E2E Subsidiary,Eliminations,Consolidated/);
  assert.match(csv, /1250,Due from group companies,40000\.00,0\.00,-40000\.00,0\.00/);

  // A partly owned subsidiary: outside shareholders get their share within equity.
  await page.getByRole('tab', { name: 'Companies, rates and rules' }).click();
  await page.getByLabel("Group's share of E2E Subsidiary (%)").fill('60');
  await members.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Save' }).waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Balance sheet' }).click();
  // Subsidiary net assets: bank 50,000 less 40,500 owed to the holding company = 9,500; 40% is 3,800.
  const bs2 = await page.getByRole('table', { name: 'Consolidated balance sheet' }).innerText();
  assert.match(bs2, /Non-controlling interests\s+₹3,800\.00/);
  assert.match(bs2, /Equity attributable to owners of the parent\s+-?₹[\d,]+\.\d\d/);
  await page.getByRole('tab', { name: 'Profit and loss' }).click();
  assert.match(await page.getByRole('table', { name: 'Consolidated profit and loss' }).innerText(), /Attributable to non-controlling interests\s+-₹16,200\.00/);
  await page.getByRole('tab', { name: 'Worksheet' }).click();
  await page.getByRole('list', { name: 'Non-controlling interests' }).getByText('E2E Subsidiary: 60% owned').waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
