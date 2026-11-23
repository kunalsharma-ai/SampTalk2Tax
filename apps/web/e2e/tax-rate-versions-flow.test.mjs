/**
 * Browser end-to-end test for effective-dated tax rates (TAX-003): an owner schedules a change to a
 * tax rate from its history page, sees it on the tax rates list, invoices on either side of the
 * date are charged at the rate in force on their dates, and the change is withdrawn before it takes
 * effect. Real Next.js app, API and MongoDB.
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
const F = addDays(T, 30);

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

test('a tax rate change is scheduled, applied by date and withdrawn', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Rates');
  await page.getByLabel('Email').fill(`e2e-rate-versions-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Versioned Rates');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const fy = Number(T.slice(0, 4)) + (T.slice(5) >= '04-01' ? 1 : 0);
  for (const y of [fy, fy + 1]) await call(`${B}/periods/fiscal-years`, { fiscalYear: y });
  const acc = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const rate = await must(call(`${B}/tax-rates`, { name: 'Service tax', rate: '10', salesAccountId: acc['2300'] }));
  const customer = (await must(call(`${B}/contacts`, { name: 'Steady Buyer', isCustomer: true }))).id;
  consoleErrors.length = 0;

  await page.goto(`${base}/settings/tax-rates`);
  await page.getByRole('link', { name: 'History of Service tax' }).click();
  await page.waitForURL(new RegExp(`/settings/tax-rates/${rate.id}$`));
  const history = page.getByRole('table', { name: 'Rate history' });
  await history.waitFor();
  assert.match(await history.locator('tbody tr').first().innerText(), /1\s+10%\s+The start[\s\S]*In force[\s\S]*The rate as created/);

  await page.getByLabel('New rate (%)').fill('12.5');
  await page.getByLabel('Takes effect on').fill(F);
  await page.getByLabel('Why (notification or reason)').fill('Rate raised by notification 7/2026');
  await page.getByRole('button', { name: 'Schedule change' }).click();
  await history.locator('tbody tr').nth(1).getByText('Scheduled').waitFor();
  assert.match(await history.locator('tbody tr').nth(1).innerText(), /2\s+12\.5%[\s\S]*Scheduled[\s\S]*Rate raised by notification 7\/2026[\s\S]*Tara Rates/);
  await page.getByText('Changes to 12.5% from').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-rate-history.png`, fullPage: true });

  // Invoices either side of the date are charged at the rate in force on their dates.
  const invoice = (date) => must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: date, dueDate: date, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '1000.00', taxRateId: rate.id }] }));
  assert.equal((await invoice(addDays(F, -1))).taxTotal, '100.00');
  assert.equal((await invoice(F)).taxTotal, '125.00');

  await page.getByRole('link', { name: 'All tax rates' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Service tax' });
  await row.getByText(/12\.5% from/).waitFor();
  assert.match(await row.innerText(), /10%[\s\S]*12\.5% from/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-rates-scheduled.png`, fullPage: true });

  await page.getByRole('link', { name: 'History of Service tax' }).click();
  await history.waitFor();
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByLabel('Why withdraw it').fill('Notification rescinded');
  await page.getByRole('button', { name: 'Withdraw change' }).click();
  const withdrawn = page.getByRole('table', { name: 'Withdrawn changes' });
  await withdrawn.waitFor();
  assert.match(await withdrawn.innerText(), /12\.5%[\s\S]*Rate raised by notification 7\/2026[\s\S]*Notification rescinded[\s\S]*Tara Rates/);
  assert.equal(await history.locator('tbody tr').count(), 1);
  await page.getByText('No change scheduled.').waitFor();
  assert.equal((await invoice(addDays(F, 1))).taxTotal, '100.00');
  assert.deepEqual(consoleErrors, []);
});
