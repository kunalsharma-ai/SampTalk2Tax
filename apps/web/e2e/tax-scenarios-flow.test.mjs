/**
 * Browser end-to-end test for tax scenario simulations (TAX-049): an owner with an advance tax
 * estimate of 50 lakh at 25% sees the regimes compared, works out a scenario with more sales,
 * expenses, depreciation and an add-back, saves it and deletes it. Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
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
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a tax scenario works out the tax, GST and cash effect and is saved', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Scenarios');
  await page.getByLabel('Email').fill(`e2e-scenarios-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Scenarios Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const y = Number(T.slice(0, 4)) - (T.slice(5) < '04-01' ? 1 : 0);
  const taxYear = `${y}-${String(y + 1).slice(2)}`;
  await must(call(`${B}/tax/advance-tax`, { taxYear, regime: 'COMPANY_25', method: 'ESTIMATE', estimatedIncome: '5000000', adjustments: [], paidAccountId: null, tdsAccountId: null, otherCredits: '200000' }, 'PUT'));

  await page.goto(`${base}/tax/scenarios`);
  const regimes = page.getByRole('table', { name: 'Regimes compared' });
  await regimes.waitFor();
  const rows = regimes.locator('tbody tr');
  assert.match(await rows.first().innerText(), /concessional rate \(22%\)[\s\S]*12,58,400\.00[\s\S]*41,600\.00/);
  assert.match(await rows.nth(1).innerText(), /Current/);

  await page.getByLabel('Change in sales').fill('2000000');
  await page.getByLabel('Change in expenses').fill('500000');
  await page.getByLabel('GST on expenses').selectOption('12');
  await page.getByLabel('Extra depreciation').fill('300000');
  await page.getByLabel('Expenses not deductible').fill('100000');
  await page.getByRole('button', { name: 'Work it out' }).click();
  const result = page.getByRole('region', { name: 'Scenario result' });
  await result.waitFor();
  const text = await result.innerText();
  assert.match(text, /Taxable income[\s\S]*63,00,000\.00/i);
  assert.match(text, /Income tax[\s\S]*16,38,000\.00/i);
  assert.match(text, /Change in tax[\s\S]*3,38,000\.00/i);
  assert.match(text, /GST on the change[\s\S]*3,00,000\.00/i);
  assert.match(text, /Cash effect[\s\S]*11,62,000\.00/i);
  assert.match(text, /not deductible raise the tax/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-scenario-result.png`, fullPage: true });

  await page.getByLabel('Scenario name').fill('New plant');
  await page.getByRole('button', { name: 'Save scenario' }).click();
  const saved = page.getByRole('table', { name: 'Saved scenarios' });
  await saved.waitFor();
  assert.match(await saved.locator('tbody tr').first().innerText(), /New plant[\s\S]*Tara Scenarios[\s\S]*63,00,000\.00[\s\S]*16,38,000\.00[\s\S]*3,38,000\.00/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-scenarios.png`, fullPage: true });

  await page.getByRole('button', { name: 'Delete New plant' }).click();
  await page.getByText('No saved scenarios').waitFor();
  assert.equal((await must(call(`${B}/tax/scenarios`))).scenarios.length, 0);
  assert.deepEqual(consoleErrors, []);
});
