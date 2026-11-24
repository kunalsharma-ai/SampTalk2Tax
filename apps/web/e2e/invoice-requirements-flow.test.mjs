/**
 * Browser end-to-end test for invoice requirements (TAX-039, TAX-040): a UK company opens
 * Tax → Invoice requirements from the navigation, sees the simplified and full VAT invoice rules,
 * finds that its full VAT invoice lacks its VAT number, its address and the customer's address,
 * puts those right in the books and sees the invoice complete after a reload, and reads that UK
 * e-invoicing starts in April 2029. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const D = new Date(Date.parse(`${T}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
const fyOf = (iso) => (Number(iso.slice(5, 7)) >= 4 ? Number(iso.slice(0, 4)) + 1 : Number(iso.slice(0, 4)));
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

test('a UK company checks its invoices against the VAT invoice rules and fixes the gaps', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Ivy Rules');
  await page.getByLabel('Email').fill(`e2e-invreq-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('GB');
  await page.getByLabel('Organisation name').fill('E2E Invoice Rules Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;

  if (fyOf(D) !== fyOf(T)) await call(`${B}/periods/fiscal-years`, { fiscalYear: fyOf(D) });
  await must(call(`${B}/country-module/starter-rates`, {}));
  const standard = (await must(call(`${B}/tax-rates`))).find((r) => r.name === 'VAT 20% (standard)').id;
  const accounts = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customer = (await must(call(`${B}/contacts`, { name: 'Synthetic Harbour Buyers Ltd', isCustomer: true }))).id;
  const inv = await must(
    call(`${B}/sales/documents`, {
      kind: 'INVOICE',
      contactId: customer,
      issueDate: D,
      dueDate: D,
      post: true,
      lines: [{ accountId: accounts['4100'], description: 'Synthetic consulting', quantity: '1', unitPrice: '1000.00', taxRateId: standard }],
    }),
  );
  consoleErrors = [];

  await page.getByRole('link', { name: 'Invoice requirements', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/tax/invoice-requirements$`));
  await page.getByRole('heading', { name: 'Invoice requirements', exact: true }).waitFor();
  const rules = page.getByRole('region', { name: 'What an invoice must show' });
  await rules.getByRole('heading', { name: 'Simplified VAT invoice', exact: true }).waitFor();
  await rules.getByRole('heading', { name: 'Full VAT invoice', exact: true }).waitFor();
  await rules.getByText(/VAT Notice 700\/21/).waitFor();

  const checked = page.getByRole('region', { name: 'Invoices against the rules' });
  const row = checked.getByRole('table', { name: 'Invoices against the rules' }).getByRole('row', { name: new RegExp(inv.number) });
  await row.getByText('Your tax registration number', { exact: true }).waitFor();
  await row.getByText('Your business address', { exact: true }).waitFor();
  await row.getByText("The customer's address", { exact: true }).waitFor();
  await row.getByText('Full VAT invoice', { exact: true }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/invoice-requirements-gaps.png`, fullPage: true });

  // E-invoicing in the UK is announced for April 2029.
  const einv = page.getByRole('region', { name: 'E-invoicing for you' });
  await einv.getByText('You will have to issue e-invoices from 2029-04-01.', { exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'E-invoicing elsewhere' })
    .getByRole('row', { name: /Germany Phasing in/ })
    .waitFor();

  // Put the gaps right in the books.
  await must(call(`${B}/tax/vat/settings`, { vrn: 'GB 123 4567 82', registeredFrom: D, stagger: 'QUARTERLY_MAR', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [] }, 'PUT'));
  await must(call(`${B}/contacts/${customer}`, { address: '9 Synthetic Road, Leeds' }, 'PATCH'));
  const tpl = await must(call(`${B}/invoice-templates`, { name: 'UK VAT', presetId: 'GB_VAT' }));
  const full = await must(call(`${B}/invoice-templates/${tpl.id}`));
  full.layout.sections.find((s) => s.key === 'HEADER').text = '1 Synthetic Quay\nBristol BS1 1AA';
  await must(call(`${B}/invoice-templates/${tpl.id}`, { name: 'UK VAT', engine: 'LAYOUT', layout: full.layout }, 'PUT'));

  await page.reload();
  await row.getByText('Complete', { exact: true }).waitFor();
  await page.getByText('GB123456782', { exact: true }).waitFor();
  assert.equal(await row.getByText('Your tax registration number', { exact: true }).count(), 0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/invoice-requirements.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
