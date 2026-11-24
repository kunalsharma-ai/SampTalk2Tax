/**
 * Browser end-to-end test for the cross-border report (TAX-038): a German company adds a French
 * customer with its country and VAT ID through the customer form, posts a zero-rated invoice to it,
 * an invoice to an Austrian customer without a VAT ID and a taxed invoice to a Swiss customer, then
 * opens Tax → Cross-border report and sees trade by country, the recapitulative statement and the
 * checks, and downloads the CSV. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const D = new Date(Date.parse(`${T}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
let browser, page;
let consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => {
  const r = await p;
  assert.ok(r.status < 300, JSON.stringify(r));
  return r.body;
};

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a German company reports its sales abroad by country', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Grete Grenzen');
  await page.getByLabel('Email').fill(`e2e-xborder-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('DE');
  await page.getByLabel('Organisation name').fill('E2E Grenzen GmbH');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  if (Number(D.slice(0, 4)) !== Number(T.slice(0, 4))) await call(`${B}/periods/fiscal-years`, { fiscalYear: Number(D.slice(0, 4)) });
  await must(call(`${B}/country-module/starter-rates`, {}));
  const rates = await must(call(`${B}/tax-rates`));
  const r19 = rates.find((r) => r.name === 'USt 19% (standard)').id;
  const r0 = rates.find((r) => r.rate === '0').id;
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));

  // The French customer comes in through the customer form, with its country.
  await page.goto(`${WEB}/orgs/${orgId}/sales/customers`);
  await page.getByRole('button', { name: 'New customer', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Synthetic Paris SARL');
  await dialog.getByLabel('Tax ID').fill('FR40303265045');
  await dialog.getByLabel('Country').selectOption('FR');
  await dialog.getByRole('button', { name: 'Save customer' }).click();
  await dialog.waitFor({ state: 'detached' });
  const contacts = await must(call(`${B}/contacts`));
  const fr = contacts.find((c) => c.name === 'Synthetic Paris SARL');
  assert.equal(fr.countryCode, 'FR');
  const at = (await must(call(`${B}/contacts`, { name: 'Synthetic Wien GmbH', isCustomer: true, countryCode: 'AT' }))).id;
  const ch = (await must(call(`${B}/contacts`, { name: 'Synthetic Zürich AG', isCustomer: true, countryCode: 'CH' }))).id;
  const inv = (contactId, unitPrice, taxRateId) =>
    must(
      call(`${B}/sales/documents`, {
        kind: 'INVOICE',
        contactId,
        issueDate: D,
        dueDate: D,
        post: true,
        lines: [{ accountId: accounts['4100'], description: 'Synthetic item', quantity: '1', unitPrice, taxRateId }],
      }),
    );
  await inv(fr.id, '1000.00', r0);
  await inv(at, '500.00', r0);
  const chInv = await inv(ch, '400.00', r19);
  consoleErrors = [];

  await page.getByRole('link', { name: 'Cross-border report', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/tax/cross-border$`));
  await page.getByRole('heading', { name: 'Cross-border report', exact: true }).waitFor();
  const trade = page.getByRole('table', { name: 'Trade by country' });
  await trade.getByRole('row', { name: /France FR, EU/ }).waitFor();
  assert.equal(await trade.getByRole('row').count(), 4);
  const recap = page.getByRole('table', { name: 'Recapitulative statement' });
  await recap.getByRole('row', { name: /Synthetic Paris SARL France FR40303265045/ }).waitFor();
  await recap.getByRole('row', { name: /Synthetic Wien GmbH Austria Missing/ }).waitFor();
  const checks = page.getByRole('table', { name: 'Cross-border checks' });
  await checks.getByRole('row', { name: new RegExp(`Tax charged on a sale abroad Invoice ${chInv.number}`) }).waitFor();
  await checks.getByRole('row', { name: /Intra-EU supply without the customer's VAT ID/ }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cross-border.png`, fullPage: true });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download cross-border report (CSV)' }).click()]);
  assert.match(download.suggestedFilename(), /^cross-border-.*\.csv$/);
  assert.deepEqual(consoleErrors, []);
});
