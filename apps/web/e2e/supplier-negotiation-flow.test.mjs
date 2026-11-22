/**
 * Browser end-to-end test for supplier negotiation help (AP-033): an owner records a steel vendor
 * whose price went from 50 to 55, paid on time and sold cheaper by another vendor; Supplier
 * negotiation lists it first with its points and saving, and its brief shows the points, the
 * item's prices and the cheaper vendor. Real Next.js app → real API → real MongoDB.
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

test('supplier negotiation shows the price rise, the cheaper vendor and the saving', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Nisha Negotiator');
  await page.getByLabel('Email').fill(`e2e-negotiation-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Negotiation Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const y = Number(T.slice(0, 4));
  for (const fiscalYear of [y - 2, y - 1, y, y + 1]) await call(`${B}/periods/fiscal-years`, { fiscalYear });
  consoleErrors.length = 0; // the refused years log a 409 in the console; only the page's own errors count below
  const vendor = (name) => must(call(`${B}/contacts`, { name, isVendor: true }));
  const bill = (who, ago, quantity, unitPrice) =>
    must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: who.id, issueDate: addDays(T, -ago), dueDate: addDays(T, -ago + 30), post: true, lines: [{ accountId: acc('6600'), description: 'Steel sheet 2mm', hsnCode: '7208', quantity, unitPrice }] }));
  const asha = await vendor('Asha Steel');
  const bharat = await vendor('Bharat Metals');
  await bill(asha, 400, '100', '40');
  for (const [ago, price] of [[300, '50'], [200, '55'], [100, '55']]) {
    const b = await bill(asha, ago, '100', price);
    await must(call(`${B}/purchases/payments`, { contactId: asha.id, date: addDays(T, -ago + 30), bankAccountId: acc('1120'), amount: b.total, allocations: [{ documentId: b.id, amount: b.total }] }));
  }
  await bill(bharat, 20, '10', '52');

  await page.goto(`${base}/purchases/negotiation`);
  const table = page.getByRole('table', { name: 'Vendors to negotiate with' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  assert.equal(await rows.count(), 2);
  const first = await rows.first().innerText();
  assert.match(first, /Asha Steel[\s\S]*3 bills[\s\S]*16,000\.00[\s\S]*\+300\.0%[\s\S]*Pays on time[\s\S]*Prices went up[\s\S]*Cheaper elsewhere[\s\S]*You buy a lot[\s\S]*You pay on time[\s\S]*1,000\.00/);
  assert.match(await rows.nth(1).innerText(), /Bharat Metals[\s\S]*Nothing stands out/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/supplier-negotiation.png`, fullPage: true });

  await rows.first().getByRole('link', { name: 'Asha Steel' }).click();
  await page.waitForURL(new RegExp(`/purchases/negotiation/${asha.id}`));
  const points = page.getByRole('list', { name: 'Points to raise' });
  await points.waitFor();
  const pointText = await points.innerText();
  assert.match(pointText, /Steel sheet 2mm: price up 10\.0%[\s\S]*You paid INR 1,000\.00 more than the first price would have cost/);
  assert.match(pointText, /Steel sheet 2mm: 5\.5% cheaper from Bharat Metals/);
  assert.match(pointText, /Ask for 45 days instead of 30/);
  const item = await page.getByRole('table', { name: 'Items bought from this vendor' }).locator('tbody tr').first().innerText();
  assert.match(item, /Steel sheet 2mm[\s\S]*HSN\/SAC 7208[\s\S]*300[\s\S]*50\.00[\s\S]*55\.00[\s\S]*\+10\.0%[\s\S]*Bharat Metals[\s\S]*52\.00[\s\S]*5\.5% lower/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/supplier-negotiation-brief.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
