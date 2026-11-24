/**
 * Browser end-to-end test for US 1099s and state returns (TAX-029): a US company pays a contractor
 * and a designer from the bank, records the contractor's W-9 through the form on Tax → US 1099s and
 * state returns, and sees the contractor's 1099-NEC due, the designer still owing a W-9, the CSV
 * export, and its Texas quarterly sales tax return with the tax charged. Real Next.js app → real
 * API → real MongoDB.
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

test('a US company sees its 1099s and state sales tax returns', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Riley Reporter');
  await page.getByLabel('Email').fill(`e2e-usrep-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('US');
  await page.getByLabel('Organisation name').fill('E2E Gadgets Inc');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const T = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  const Q = Math.ceil(Number(T.slice(5, 7)) / 3);
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const vendor = async (name) => (await must(call(`${B}/contacts`, { name, isVendor: true, countryCode: 'US' }))).id;
  const contractor = await vendor('Synthetic Contractor');
  const designer = await vendor('Synthetic Designer');
  for (const [contactId, amount] of [
    [contractor, '1800.00'],
    [contractor, '700.00'],
    [designer, '2600.00'],
  ])
    await must(call(`${B}/purchases/payments`, { contactId, date: T, bankAccountId: accounts['1120'], amount, reference: `SYN-${amount}` }));
  const rate = (await must(call(`${B}/tax-rates`, { name: 'Texas 8.25%', rate: '8.25', salesAccountId: accounts['2300'], purchaseAccountId: accounts['1450'] }))).id;
  await must(call(`${B}/tax/us-sales-tax/registrations/TX`, { registeredFrom: `${T.slice(0, 4)}-01-01`, taxRateId: rate, filingFrequency: 'QUARTERLY' }, 'PUT'));
  const buyer = (await must(call(`${B}/contacts`, { name: 'Synthetic Austin LLC', isCustomer: true, regionCode: 'TX' }))).id;
  await must(
    call(`${B}/sales/documents`, {
      kind: 'INVOICE',
      contactId: buyer,
      issueDate: T,
      dueDate: T,
      post: true,
      lines: [{ accountId: accounts['4100'], description: 'Synthetic gadget', quantity: '1', unitPrice: '4000.00', taxRateId: rate }],
    }),
  );
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}`);
  await page.getByRole('link', { name: 'US 1099s and state returns', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/tax/us-reporting$`));
  await page.getByRole('heading', { name: 'US 1099s and state returns', exact: true }).waitFor();
  const returns = page.getByRole('table', { name: '1099s for the year' });
  await returns.getByRole('row', { name: /Synthetic Contractor 2 payments Get a W-9/ }).waitFor();

  // The contractor's W-9 goes in through the form.
  const w9 = page.getByRole('region', { name: 'Vendor W-9 details' });
  await w9.getByRole('button', { name: 'Add W-9 for Synthetic Contractor' }).click();
  const form = page.getByRole('form', { name: 'W-9 details' });
  await form.getByLabel('Tax classification').selectOption('INDIVIDUAL');
  await form.getByLabel('Number type').selectOption('SSN');
  await form.getByLabel('Last 4 digits').fill('4321');
  const { today: day } = await must(call(`${B}/tax/us-reporting`));
  await form.getByLabel('W-9 received').fill(day);
  await form.getByLabel('Paid for').selectOption('NEC');
  await form.getByRole('button', { name: 'Save W-9' }).click();
  await form.waitFor({ state: 'detached' });
  await returns.getByRole('row', { name: /Synthetic Contractor 2 payments File a 1099 1099-NEC box 1 \$2,500\.00 \$2,500\.00 SSN ending 4321/ }).waitFor();
  await returns.getByRole('row', { name: /Synthetic Designer 1 payment Get a W-9/ }).waitFor();
  await page.getByText('1 vendor needs a W-9', { exact: true }).waitFor();
  const saved = await must(call(`${B}/tax/us-reporting`));
  assert.deepEqual(saved.vendors.find((v) => v.contactId === contractor).profile, {
    classification: 'INDIVIDUAL',
    tinType: 'SSN',
    tinLast4: '4321',
    w9ReceivedOn: day,
    formKind: 'NEC',
    isAttorney: false,
  });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export 1099 CSV' }).click()]);
  assert.equal(download.suggestedFilename(), `us-1099-${T.slice(0, 4)}.csv`);

  await page
    .getByRole('table', { name: 'State sales tax returns' })
    .getByRole('row', { name: new RegExp(`Texas Q${Q} ${T.slice(0, 4)} .* In progress \\$4,000\\.00 \\$330\\.00 1`) })
    .waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/us-reporting.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
