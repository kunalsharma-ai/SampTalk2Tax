/**
 * Browser end-to-end test for vendor contract compliance (AP-032): an owner records a steel contract
 * through the form; a bill above the contract price and due too soon shows both findings on the
 * contract and on Vendor contracts; the contract is then terminated. Real Next.js app, API and MongoDB.
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

test('a vendor contract flags a bill above the contract price and with shorter terms', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Kavya Contracts');
  await page.getByLabel('Email').fill(`e2e-contracts-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Contracts Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = (code) => (accounts.accounts ?? accounts).find((a) => a.code === code).id;
  const y = Number(T.slice(0, 4));
  for (const fiscalYear of [y - 1, y, y + 1]) await call(`${B}/periods/fiscal-years`, { fiscalYear });
  consoleErrors.length = 0; // the refused years log a 409 in the console; only the page's own errors count below
  const asha = await must(call(`${B}/contacts`, { name: 'Asha Steel', isVendor: true }));
  const bill = (ago, dueIn, unitPrice) =>
    must(call(`${B}/purchases/documents`, { kind: 'BILL', contactId: asha.id, issueDate: addDays(T, -ago), dueDate: addDays(T, -ago + dueIn), post: true, lines: [{ accountId: acc('6600'), description: 'Steel sheet 2mm', hsnCode: '7208', quantity: '100', unitPrice }] }));
  await bill(60, 30, '50');
  const bad = await bill(20, 15, '52');

  await page.goto(`${base}/purchases/vendor-contracts`);
  await page.getByRole('link', { name: 'Record a contract' }).click();
  await page.waitForURL(/\/purchases\/vendor-contracts\/new$/);
  await page.getByLabel('Vendor', { exact: true }).selectOption({ label: 'Asha Steel' });
  await page.getByLabel('Title').fill('Steel supply');
  await page.getByLabel('Starts').fill(addDays(T, -100));
  await page.getByLabel('Ends').fill(addDays(T, 200));
  await page.getByLabel('Payment terms').fill('30');
  await page.getByLabel('HSN/SAC 1').fill('7208');
  await page.getByLabel('Item 1').fill('Steel sheet 2mm');
  await page.getByLabel('Unit price 1').fill('50');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/vendor-contract-new.png`, fullPage: true });
  await page.getByRole('button', { name: 'Record contract' }).click();
  await page.waitForURL(/\/purchases\/vendor-contracts\/[0-9a-f-]{24,36}$/);
  const id = page.url().split('/').pop();

  const findings = page.getByRole('table', { name: 'Findings on bills' });
  await findings.waitFor();
  const text = await findings.innerText();
  assert.match(text, new RegExp(`${bad.number}[\\s\\S]*Price above contract[\\s\\S]*200\\.00[\\s\\S]*billed 52\\.00 a unit, the contract price is 50\\.00`));
  assert.match(text, /Shorter payment terms[\s\S]*Due 15 days after the bill date; the contract gives 30 days/);
  assert.equal(await findings.locator('tbody tr').count(), 2);
  assert.match(await page.getByRole('table', { name: 'Contract prices' }).innerText(), /7208[\s\S]*50\.00/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/vendor-contract-detail.png`, fullPage: true });

  await page.goto(`${base}/purchases/vendor-contracts`);
  const issues = page.getByRole('table', { name: 'Bills breaking a contract' });
  await issues.waitFor();
  assert.match(await issues.locator('tbody tr').first().innerText(), /High[\s\S]*Price above contract[\s\S]*Asha Steel[\s\S]*VC-001[\s\S]*200\.00/);
  assert.match(await page.getByRole('table', { name: 'Contracts' }).innerText(), /VC-001[\s\S]*Asha Steel[\s\S]*In force[\s\S]*10,200\.00[\s\S]*2/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/vendor-contracts.png`, fullPage: true });

  await page.goto(`${base}/purchases/vendor-contracts/${id}`);
  await page.getByLabel('Reason').fill('Prices renegotiated');
  await page.getByLabel('Last day').fill(addDays(T, -1));
  await page.getByRole('button', { name: 'Terminate' }).click();
  await page.getByText('Prices renegotiated').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Terminate' }).count(), 0);
  const ended = await must(call(`${B}/purchases/vendor-contracts/${id}`));
  assert.equal(ended.state, 'TERMINATED');
  assert.deepEqual(consoleErrors, []);
});
