/**
 * Browser end-to-end test for settling bills (AP-008, AP-009, AP-010): a vendor was overpaid on
 * one bill; on the next bill the owner sees the unapplied payment and applies it in one click,
 * then applies a vendor credit through the dialog, leaving the rest still due. Real Next.js app,
 * API and MongoDB.
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

async function call(path, body) {
  return page.evaluate(
    async ([u, b]) => {
      const r = await fetch(`/api/t2t${u}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };
const stillDue = async () => (await page.getByText('Still due', { exact: true }).locator('..').textContent()).replace(/\s+/g, ' ');

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an overpayment and a vendor credit settle the next bill', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Pooja Payables');
  await page.getByLabel('Email').fill(`e2e-settlement-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Settling Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = (await must(call(`${B}/contacts`, { name: 'Synthetic Paper Mills', isVendor: true }))).id;
  const bill = (amount, reference) => must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: vendor, issueDate: T, dueDate: T, reference, post: true, lines: [{ accountId: acc['6600'], description: 'Paper', quantity: '1', unitPrice: amount }] }));
  const b1 = await bill('10000.00', 'SPM/101');
  const pay = await must(call(`${B}/purchases/payments`, { contactId: vendor, date: T, bankAccountId: acc['1120'], amount: '12000.00', reference: 'UTR-OVER', allocations: [{ documentId: b1.id, amount: '10000.00' }] }));
  assert.equal(pay.unallocated, '2000.00');
  const b2 = await bill('5000.00', 'SPM/102');
  await must(call(`${B}/purchases/documents`, { kind: 'VENDOR_CREDIT', contactId: vendor, issueDate: T, reference: 'SPM/CN/7', post: true, lines: [{ accountId: acc['6600'], description: 'Short supply', quantity: '1', unitPrice: '1000.00' }] }));
  consoleErrors.length = 0;

  await page.goto(`${base}/purchases/bills/${b2.id}`);
  const unapplied = page.getByRole('region', { name: 'Unapplied vendor payments' });
  await unapplied.getByRole('link', { name: pay.number }).waitFor();
  assert.match(await stillDue(), /5,000\.00/);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/unapplied-vendor-payment.png`, fullPage: true });
  await unapplied.getByRole('button', { name: /Apply/ }).click();
  await unapplied.waitFor({ state: 'detached' });
  await page.waitForFunction(() => /Still due\s*₹3,000\.00/i.test(document.body.innerText));

  await page.getByRole('button', { name: 'Apply vendor credit…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Vendor credit').selectOption({ index: 1 });
  assert.equal(await dialog.getByLabel('Amount to apply').inputValue(), '1000.00');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => /Still due\s*₹2,000\.00/i.test(document.body.innerText));
  const body = await page.locator('main').innerText();
  const applied = body.slice(body.search(/Payments and credits applied/i));
  assert.match(applied, new RegExp(pay.number));
  assert.match(applied, /VC-000001/);
  assert.deepEqual(consoleErrors, []);
});
