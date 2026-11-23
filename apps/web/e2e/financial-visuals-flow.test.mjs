/**
 * Browser end-to-end test for financial visuals (DASH-028/029/030/031/034): an owner with posted
 * revenue and spending opens Reports → Financial visuals, sees the waterfall, the Sankey, the
 * spending heatmap and the treemap with their tables, drills from a waterfall bar into the
 * accounts behind it and on to an account's general ledger, and opens a heatmap cell's ledger
 * for that month. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const ok = (r, what) => {
  assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner explores the profit and loss as a waterfall, Sankey, heatmap and treemap and drills into the ledger', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Vera Visuals');
  await page.getByLabel('Email').fill(`e2e-visuals-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Visual Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  ok(await call(`${base}/journals`, { date: today(), memo: 'Sales', post: true, lines: [{ accountId: acc['1120'], debit: '250000.00' }, { accountId: acc['4100'], credit: '180000.00' }, { accountId: acc['4200'], credit: '70000.00' }] }), 'sales');
  ok(
    await call(`${base}/journals`, {
      date: today(),
      memo: 'Costs',
      post: true,
      lines: [
        { accountId: acc['5000'], debit: '90000.00' },
        { accountId: acc['6100'], debit: '60000.00' },
        { accountId: acc['6200'], debit: '24000.00' },
        { accountId: acc['6400'], debit: '8000.00' },
        { accountId: acc['6500'], debit: '6000.00' },
        { accountId: acc['1120'], credit: '188000.00' },
      ],
    }),
    'costs',
  );
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/reports/visuals`);
  const steps = page.getByRole('table', { name: 'Waterfall steps' });
  await steps.getByRole('row', { name: /Gross profit/ }).getByText('₹1,60,000.00').first().waitFor();
  await steps.getByRole('row', { name: /Net profit/ }).getByText('₹62,000.00').first().waitFor();
  await page.getByRole('img', { name: /Waterfall from revenue to net profit/ }).locator('.recharts-bar-rectangle').first().waitFor();
  await page.getByRole('img', { name: /flowing to spending and profit/ }).locator('.recharts-sankey-link').first().waitFor();
  const heat = page.getByRole('table', { name: 'Spending by account and month' });
  await heat.getByRole('rowheader', { name: /Cost of Sales/ }).waitFor();
  const groups = page.getByRole('table', { name: 'Spending groups' });
  await groups.getByRole('row', { name: /Operating costs/ }).getByText('20.2%').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/financial-visuals.png`, fullPage: true });

  // Drill down: the operating costs step lists its accounts, each opening its ledger.
  await steps.getByRole('button', { name: 'Operating costs' }).click();
  const behind = page.getByRole('table', { name: 'Accounts in Operating costs' });
  await behind.getByRole('link', { name: 'Rent' }).waitFor();
  assert.equal(await behind.getByRole('row').count(), 4);
  await behind.getByRole('link', { name: 'Rent' }).click();
  await page.waitForURL(/\/reports\/general-ledger\?accountId=/);
  assert.ok(page.url().includes(acc['6200']));

  // A heatmap cell opens that month's ledger.
  await page.goBack();
  await heat.getByRole('link', { name: /^Salaries and Wages, / }).last().click();
  await page.waitForURL(/\/reports\/general-ledger\?accountId=/);
  assert.ok(page.url().includes(acc['6100']));
  assert.ok(page.url().includes(`from=${today().slice(0, 7)}-01`));
  assert.deepEqual(consoleErrors, []);
});
