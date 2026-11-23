/**
 * Browser end-to-end test for source-backed tax explanations (TAX-052): an owner opens an
 * intra-state invoice and asks how the tax was worked out, sees each point with the law or the
 * record it comes from and the rate change it was issued under, then opens a reverse-charge bill
 * without an HSN code and sees reverse charge explained and the missing code flagged.
 * Real Next.js app, API and MongoDB.
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
const day = (n) => new Date(Date.parse(`${T}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const FY = Number(T.slice(5, 7)) >= 4 ? Number(T.slice(0, 4)) + 1 : Number(T.slice(0, 4)); // not money

// GSTIN check character (mod-36 Luhn), so the synthetic GSTINs are valid.
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1); // not money
    sum += Math.floor(p / 36) + (p % 36); // not money
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36];
};

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

test('the tax on an invoice and a bill is explained with its sources', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Esha Explains');
  await page.getByLabel('Email').fill(`e2e-tax-explanation-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Explained Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  await call(`${B}/periods/fiscal-years`, { fiscalYear: FY });
  await must(call(`${B}/gst/registration`, { gstin: gstin('27ZZZTE9001Z1Z'), legalName: 'E2E Explained Traders Pvt Ltd', effectiveFrom: day(-60) }, 'PUT'));
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const rate = (await must(call(`${B}/tax-rates`, { name: 'GST standard', rate: '12', kind: 'GST' }))).id;
  await must(call(`${B}/tax-rates/${rate}/versions`, { rate: '18', effectiveFrom: day(-10), reason: 'Synthetic rate change' }));
  const pune = (await must(call(`${B}/contacts`, { name: 'Pune Buyers', isCustomer: true, gstin: gstin('27ZZZTE9002Z1Z') }))).id;
  const advocate = (await must(call(`${B}/contacts`, { name: 'Adv. Synthetic Iyer', isVendor: true, stateCode: '27' }))).id;
  const invoice = await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: pune, issueDate: T, dueDate: T, post: true, lines: [{ accountId: acc['4100'], description: 'Laptops', quantity: '1', unitPrice: '10000.00', taxRateId: rate, hsnCode: '8471' }] }));
  const bill = await must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: advocate, issueDate: T, dueDate: T, post: true, reverseCharge: true, lines: [{ accountId: acc['6600'], description: 'Legal opinion', quantity: '1', unitPrice: '20000.00', taxRateId: rate, hsnCode: '998211' }] }));
  consoleErrors.length = 0;

  await page.goto(`${base}/sales/invoices/${invoice.id}`);
  const card = page.getByRole('region', { name: 'How the tax was worked out' });
  await card.getByText('Tax on this invoice: GST INR 1800.00.').waitFor();
  await card.getByRole('button', { name: 'Explain the tax' }).click();
  const points = card.getByRole('list', { name: 'Explanation' });
  await points.waitFor();
  assert.match(await points.innerText(), /Place of supply\s+The place of supply is Maharashtra \(27\)[\s\S]*Law: IGST Act, 2017, s\.10 \(goods\) and s\.12 \(services\)[\s\S]*Intra-state: CGST and SGST/);
  const lines = await card.getByRole('list', { name: 'Tax on each line' }).innerText();
  assert.match(lines, new RegExp(`Line 1: Laptops \\(HSN/SAC 8471\\)\\s+INR 10000\\.00 at 18% = CGST 9% INR 900\\.00 and SGST 9% INR 900\\.00[\\s\\S]*"GST standard" was 12% when it was set up; 18% has been in force since ${day(-10)}`));
  assert.match(lines, /Books: Rate versions of "GST standard"/);
  assert.match(await card.innerText(), /no AI model is used/);
  await card.scrollIntoViewIfNeeded();
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/tax-explanation.png` });

  await page.goto(`${base}/purchases/bills/${bill.id}`);
  await card.getByText('Tax on this bill: GST INR 3600.00 payable by you under reverse charge.').waitFor();
  await card.getByRole('button', { name: 'Explain the tax' }).click();
  assert.match(await card.getByRole('list', { name: 'Explanation' }).innerText(), /Reverse charge\s+You, not Adv\. Synthetic Iyer, pay the GST on this bill because it is legal services by an advocate[\s\S]*self-invoice within 30 days[\s\S]*Law: CGST Act, 2017, s\.49\(4\) \(paid in cash\)/);
  await card.getByRole('button', { name: 'Hide the explanation' }).click();
  assert.equal(await card.getByRole('list', { name: 'Explanation' }).count(), 0);
  assert.deepEqual(consoleErrors, []);
});
