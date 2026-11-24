/**
 * Browser end-to-end test for US sales tax (TAX-028): a US company adds a Texas customer through the
 * customer form with its state, records its Texas permit and rate on Tax → US sales tax, sells into
 * Texas and Washington, and sees Washington over the economic nexus threshold, Texas tax by state and
 * an untaxed Texas sale to check. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
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
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a US company tracks nexus and sales tax by state', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Sam Statewide');
  await page.getByLabel('Email').fill(`e2e-ussales-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('US');
  await page.getByLabel('Organisation name').fill('E2E Widgets Inc');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const T = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  await must(call(`${B}/tax-rates`, { name: 'Texas 8.25%', rate: '8.25', salesAccountId: accounts['2300'], purchaseAccountId: accounts['1450'] }));

  // The Texas customer comes in through the customer form, with its state.
  await page.goto(`${WEB}/orgs/${orgId}/sales/customers`);
  await page.getByRole('button', { name: 'New customer', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Synthetic Austin LLC');
  await dialog.getByLabel('State', { exact: true }).selectOption('TX');
  await dialog.getByRole('button', { name: 'Save customer' }).click();
  await dialog.waitFor({ state: 'detached' });
  const tx = (await must(call(`${B}/contacts`))).find((c) => c.name === 'Synthetic Austin LLC');
  assert.equal(tx.regionCode, 'TX');
  const wa = (await must(call(`${B}/contacts`, { name: 'Synthetic Seattle LLC', isCustomer: true, regionCode: 'WA' }))).id;
  consoleErrors = [];

  await page.getByRole('link', { name: 'US sales tax', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/tax/us-sales-tax$`));
  await page.getByRole('heading', { name: 'US sales tax', exact: true }).waitFor();
  const permits = page.getByRole('region', { name: 'Your state permits' });
  await permits.getByLabel('State').selectOption('TX');
  await permits.getByLabel('Permit number').fill('32000000000');
  await permits.getByLabel('Rate charged').selectOption({ label: 'Texas 8.25% (8.25%)' });
  await permits.getByRole('button', { name: 'Save permit' }).click();
  await permits
    .getByRole('table', { name: 'Your state permits' })
    .getByRole('row', { name: /Texas 32000000000/ })
    .waitFor();

  const rate = (await must(call(`${B}/tax-rates`))).find((r) => r.name === 'Texas 8.25%').id;
  const sell = (contactId, unitPrice, taxRateId) =>
    must(
      call(`${B}/sales/documents`, {
        kind: 'INVOICE',
        contactId,
        issueDate: T,
        dueDate: T,
        post: true,
        lines: [{ accountId: accounts['4100'], description: 'Synthetic widget', quantity: '1', unitPrice, ...(taxRateId ? { taxRateId } : {}) }],
      }),
    );
  await sell(tx.id, '1000.00', rate);
  const untaxed = await sell(tx.id, '300.00');
  await sell(wa, '150000.00');
  await page.reload();

  const nexus = page.getByRole('table', { name: 'Economic nexus by state' });
  await nexus.getByRole('row', { name: /Washington WA Over the threshold/ }).waitFor();
  await nexus.getByRole('row', { name: /Texas TX Registered/ }).waitFor();
  const byState = page.getByRole('table', { name: 'Sales tax by state' });
  await byState.getByRole('row', { name: /Texas Registered, 2 documents \$1,300\.00 \$1,000\.00 \$300\.00 \$82\.50/ }).waitFor();
  await page
    .getByRole('table', { name: 'Sales tax to check' })
    .getByRole('row', { name: new RegExp(`No tax on a sale into a registered state ${untaxed.number}`) })
    .waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/us-sales-tax.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
