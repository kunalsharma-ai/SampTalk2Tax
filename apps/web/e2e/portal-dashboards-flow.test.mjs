/**
 * Browser end-to-end test for the portal dashboards (DASH-060/061): a business invoices a customer
 * and is billed by a vendor, records a payment each way, and sends each a private link. With no
 * session, the customer and then the vendor see what is open by how late it is, what is due next,
 * and a year of invoices and payments, as charts with tables.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
let browser, page;
const consoleErrors = [];
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

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a customer and a vendor read their portal dashboards', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Portal Dashboard Owner');
  await page.getByLabel('Email').fill(`e2e-portal-dash-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Portal Dashboard Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const B = `/v1/orgs/${page.url().split('/').pop()}`;
  const acc = Object.fromEntries(ok(await call(`${B}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const cust = ok(await call(`${B}/contacts`, { name: 'Lotus Hotels', isCustomer: true }), 'customer');
  const vend = ok(await call(`${B}/contacts`, { name: 'Teak Furniture', isVendor: true }), 'vendor');
  const inv = async (amount, issueDate) => {
    const d = ok(
      await call(`${B}/sales/documents`, {
        kind: 'INVOICE',
        contactId: cust.id,
        issueDate,
        dueDate: addDays(issueDate, 15),
        lines: [{ accountId: acc['4100'], description: 'Rooms', quantity: '1', unitPrice: amount }],
      }),
      'invoice',
    );
    return ok(await call(`${B}/sales/documents/${d.id}/post`, {}), 'post');
  };
  const bill = async (amount, issueDate, reference) =>
    ok(
      await call(`${B}/purchases/documents`, {
        kind: 'BILL',
        contactId: vend.id,
        issueDate,
        dueDate: addDays(issueDate, 30),
        reference,
        post: true,
        lines: [{ accountId: acc['6600'], quantity: '1', unitPrice: amount }],
      }),
      'bill',
    );
  const old = await inv('10000.00', addDays(T, -40));
  await inv('6000.00', T);
  ok(
    await call(`${B}/sales/payments`, { contactId: cust.id, date: T, bankAccountId: acc['1120'], amount: '4000.00', reference: 'NEFT 1', allocations: [{ documentId: old.id, amount: '4000.00' }] }),
    'receipt',
  );
  const oldBill = await bill('20000.00', addDays(T, -45), 'TF/1');
  await bill('8000.00', addDays(T, -5), 'TF/2');
  ok(
    await call(`${B}/purchases/payments`, {
      contactId: vend.id,
      date: T,
      bankAccountId: acc['1120'],
      amount: '15000.00',
      reference: 'UTR 1',
      allocations: [{ documentId: oldBill.id, amount: '15000.00' }],
    }),
    'payment',
  );
  const customerPath = ok(await call(`${B}/contacts/${cust.id}/portal-links`, { expiresInDays: 30 }), 'customer link').path;
  const vendorPath = ok(await call(`${B}/contacts/${vend.id}/vendor-portal-links`, { expiresInDays: 30 }), 'vendor link').path;

  // The customer, with no session.
  const outside = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const cp = await outside.newPage();
  cp.on('console', (m) => m.type() === 'error' && consoleErrors.push(`portal: ${m.text()}`));
  await cp.goto(`${WEB}${customerPath}`);
  const owe = cp.getByRole('region', { name: 'What you owe, by how late it is' });
  await owe.getByText(/₹12,000\.00 open, of which ₹6,000\.00 is past its due date/).waitFor();
  await owe.getByText(new RegExp(`Next payment due: ₹6,000\\.00`)).waitFor();
  await owe.getByRole('img', { name: /Open amounts by how late they are/ }).waitFor();
  assert.match(
    await owe
      .getByRole('table', { name: 'Open by how late' })
      .getByRole('row', { name: /1–30 days late/ })
      .innerText(),
    /1[\s\S]*6,000\.00/,
  );
  const year = cp.getByRole('region', { name: 'Your year with us' });
  await year.getByText(/invoiced to you ₹16,000\.00 \(less credit notes\) and you paid ₹4,000\.00/).waitFor();
  await year.getByRole('img', { name: /Invoices and payments each month/ }).waitFor();
  if (SHOTS) await cp.screenshot({ path: `${SHOTS}/portal-dashboard-customer.png`, fullPage: true });

  // The vendor, with no session.
  await cp.goto(`${WEB}${vendorPath}`);
  const owed = cp.getByRole('region', { name: 'What you are owed, by how late it is' });
  await owed.getByText(/₹13,000\.00 open, of which ₹5,000\.00 is past its due date/).waitFor();
  await owed.getByText(/Next payment to you: ₹8,000\.00/).waitFor();
  await cp
    .getByRole('region', { name: 'Your year with us' })
    .getByText(/you billed ₹28,000\.00 \(less credit notes\) and paid to you ₹15,000\.00/)
    .waitFor();
  if (SHOTS) await cp.screenshot({ path: `${SHOTS}/portal-dashboard-vendor.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
