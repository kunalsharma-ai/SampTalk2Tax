/**
 * Browser end-to-end test for customer behaviour analysis (AR-038): an owner records a customer
 * who paid two days late until six months ago and twenty days late since, and one who bought
 * every month and then stopped; Customer behaviour shows both first with their signals, and the
 * signal filter narrows the list. Real Next.js app → real API → real MongoDB.
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

test('customer behaviour shows who is paying slower and who stopped buying', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Bina Behaviour');
  await page.getByLabel('Email').fill(`e2e-behaviour-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Behaviour Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  // Open the earlier fiscal years the history needs; a year that already exists is refused, which is fine.
  const y = Number(T.slice(0, 4));
  for (const fiscalYear of [y - 2, y - 1, y, y + 1]) await call(`${B}/periods/fiscal-years`, { fiscalYear });
  consoleErrors.length = 0; // the refused years log a 409 in the console; only the page's own errors count below
  const customer = (name) => must(call(`${B}/contacts`, { name, isCustomer: true }));
  const paid = async (who, ago, late) => {
    const issueDate = addDays(T, -ago);
    const i = await must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId: who.id, issueDate, dueDate: addDays(issueDate, 30), post: true, lines: [{ accountId: acc('4100'), quantity: '1', unitPrice: '1000' }] }));
    if (late != null) await must(call(`${B}/sales/payments`, { contactId: who.id, date: addDays(issueDate, 30 + late), bankAccountId: acc('1120'), amount: '1000.00', allocations: [{ documentId: i.id, amount: '1000.00' }] }));
  };
  const slow = await customer('Slowpay Stores');
  for (const ago of [330, 300, 270, 240]) await paid(slow, ago, 2);
  for (const ago of [150, 120, 90]) await paid(slow, ago, 20);
  await paid(slow, 20, null);
  const quiet = await customer('Gone Quiet Co');
  for (const ago of [400, 370, 340, 310, 280]) await paid(quiet, ago, 0);

  await page.goto(`${base}/sales/customer-behaviour`);
  const table = page.getByRole('table', { name: 'Customer behaviour' });
  await table.waitFor();
  const rows = table.locator('tbody tr');
  assert.equal(await rows.count(), 2);
  const text = (await rows.allInnerTexts()).join('\n');
  assert.match(text, /Slowpay Stores[\s\S]*Pays late, steadily[\s\S]*paying slower[\s\S]*Paying 18 days later than six months before/);
  assert.match(text, /Gone Quiet Co[\s\S]*Stopped buying[\s\S]*No invoice for 280 days; usually one every 30 days/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/customer-behaviour.png`, fullPage: true });

  await page.getByLabel('Signal').selectOption('LAPSED');
  await rows.first().getByText('Gone Quiet Co').waitFor();
  assert.equal(await rows.count(), 1);
  await page.getByLabel('Signal').selectOption('BUYING_LESS');
  await page.getByText('No customer has this signal.').waitFor();
  await page.getByLabel('Signal').selectOption('');
  await rows.getByRole('link', { name: 'Slowpay Stores' }).click();
  await page.waitForURL(new RegExp(`/sales/customers/${slow.id}`));
  assert.deepEqual(consoleErrors, []);
});
