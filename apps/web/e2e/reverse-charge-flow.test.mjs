/**
 * Browser end-to-end test for reverse charge (TAX-032): an owner with reverse-charge bills from an
 * unregistered advocate and a registered transport agency, and a security agency's bill recorded
 * without reverse charge, sees the month's register and the tax to pay, the bill that may need
 * reverse charge, and issues the advocate's self-invoice. Real Next.js app, API and MongoDB.
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
const FY = Number(T.slice(5, 7)) >= 4 ? Number(T.slice(0, 4)) : Number(T.slice(0, 4)) - 1; // not money
const FY_LABEL = `${FY}-${String((FY + 1) % 100).padStart(2, '0')}`;

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

test('reverse charge: the register, a bill that may need it, and a self-invoice', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Ravi Reverse');
  await page.getByLabel('Email').fill(`e2e-reverse-charge-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Reverse Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  await call(`${B}/periods/fiscal-years`, { fiscalYear: FY + 1 });
  await must(call(`${B}/gst/registration`, { gstin: gstin('27ZZZRC9001Z1Z'), legalName: 'E2E Reverse Traders Pvt Ltd', effectiveFrom: `${T.slice(0, 7)}-01` }, 'PUT'));
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const r18 = (await must(call(`${B}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' }))).id;
  const advocate = (await must(call(`${B}/contacts`, { name: 'Adv. Synthetic Rao', isVendor: true, stateCode: '27' }))).id;
  const gta = (await must(call(`${B}/contacts`, { name: 'Registered Synthetic Transport', isVendor: true, gstin: gstin('27ZZZRC9002Z1Z') }))).id;
  const guards = (await must(call(`${B}/contacts`, { name: 'Synthetic Guards Pvt Ltd', isVendor: true, gstin: gstin('27ZZZRC9003Z1Z') }))).id;
  const bill = (contactId, amount, hsnCode, extra = {}) => must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId, issueDate: T, dueDate: T, post: true, lines: [{ accountId: acc['6600'], description: 'Services', quantity: '1', unitPrice: amount, taxRateId: r18, hsnCode }], ...extra }));
  const legal = await bill(advocate, '50000.00', '998211', { reverseCharge: true }); // CGST 4,500 + SGST 4,500
  await bill(gta, '20000.00', '996511', { reverseCharge: true }); // CGST 1,800 + SGST 1,800
  await bill(guards, '30000.00', '998525');
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/reverse-charge`);
  const register = page.getByRole('region', { name: 'Reverse charge register' });
  await register.getByText(legal.number).waitFor();
  const text = await register.innerText();
  assert.match(text, /Adv\. Synthetic Rao\s+Not registered\s+Legal services by an advocate/);
  assert.match(text, /Registered Synthetic Transport[\s\S]*Goods transport agency \(GTA\)[\s\S]*Not needed/);
  assert.match(text, /To issue/);
  assert.match(text, /Total\s+₹70,000\.00\s+₹0\.00\s+₹6,300\.00\s+₹6,300\.00/);
  assert.match(await page.locator('main').innerText(), /Tax to pay in cash\s+₹12,600\.00[\s\S]*Self-invoices\s+0 of 1/);
  const missed = page.getByRole('region', { name: 'Bills that may need reverse charge' });
  assert.match(await missed.innerText(), /Synthetic Guards Pvt Ltd\s+Security services\s+HSN\/SAC 998525[\s\S]*by a person other than a body corporate[\s\S]*₹5,400\.00/);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/reverse-charge.png`, fullPage: true });

  await register.getByRole('link', { name: /^Due / }).click();
  await page.waitForURL(/\/tax\/reverse-charge\/[0-9a-f-]{36}$/);
  const invoice = page.getByRole('region', { name: 'Self-invoice', exact: true });
  await invoice.getByText('Tax invoice (draft)').waitFor();
  assert.match(await invoice.innerText(), /E2E Reverse Traders Pvt Ltd[\s\S]*Adv\. Synthetic Rao\s+Not registered[\s\S]*998211[\s\S]*₹50,000\.00/);
  await page.getByRole('region', { name: 'Issue the self-invoice' }).getByRole('button', { name: 'Issue self-invoice' }).click();
  const number = `RCM/${FY_LABEL}/0001`;
  await page.getByRole('heading', { name: `Self-invoice ${number}` }).waitFor();
  assert.match(await invoice.innerText(), new RegExp(`Tax invoice ${number}[\\s\\S]*by Ravi Reverse[\\s\\S]*Tax payable on reverse charge: yes[\\s\\S]*GST payable by you on reverse charge: ₹9,000\\.00`));
  assert.equal(await page.getByRole('button', { name: 'Issue self-invoice' }).count(), 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/reverse-charge-self-invoice.png`, fullPage: true });

  await page.getByRole('link', { name: 'Back to reverse charge' }).click();
  await register.getByRole('link', { name: number }).waitFor();
  assert.match(await page.locator('main').innerText(), /Self-invoices\s+1 of 1/);
  assert.deepEqual(consoleErrors, []);
});
