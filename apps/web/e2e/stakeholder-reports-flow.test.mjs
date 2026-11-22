/**
 * Browser end-to-end test for executive and investor reports (RPT-022, RPT-023): postings in the
 * last complete fiscal quarter and the one before; the executive report shows the headline, points
 * for attention and the named customers, the narrative is saved and the report finalised; the
 * investor report never names a customer. Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const m = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by; // not money
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`; // not money
};
const fiscalYear = (d) => (Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) + 1 : Number(d.slice(0, 4)));
// The first month of the current fiscal quarter (April start), then the last complete quarter and the one before.
const qStart = shift(T.slice(0, 7), -((Number(T.slice(5, 7)) - 4 + 12) % 3));
const Q = [shift(qStart, -3), shift(qStart, -2), shift(qStart, -1)];
const P = [shift(qStart, -6), shift(qStart, -5), shift(qStart, -4)];
const qLabel = (first) => {
  const fy = fiscalYear(`${first}-01`);
  return `Q${Math.floor(((Number(first.slice(5, 7)) - 4 + 12) % 12) / 3) + 1} FY ${fy - 1}-${String(fy % 100).padStart(2, '0')}`; // not money
};

let browser, page;
const consoleErrors = [];

async function call(path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
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

test('executive and investor reports show the quarter, save the narrative and finalise', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Esha Executive');
  await page.getByLabel('Email').fill(`e2e-stakeholder-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Board Report Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  for (const fy of new Set([`${P[0]}-01`, `${Q[0]}-01`, T].map(fiscalYear))) await call(`${B}/periods/fiscal-years`, { fiscalYear: fy });
  consoleErrors.length = 0; // the refused years log a 409 in the console; only the page's own errors count below
  const acc = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const customer = async (name) => (await must(call(`${B}/contacts`, { name, isCustomer: true }))).id;
  const [alpha, beta] = [await customer('Alpha Retail'), await customer('Beta Foods')];
  const invoice = (contactId, date, amount) => must(call(`${B}/sales/documents`, { kind: 'INVOICE', contactId, issueDate: date, dueDate: date, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] }));
  const journal = (date, debit, credit, amount) => must(call(`${B}/journals`, { date, post: true, memo: 'Board report test', lines: [{ accountId: acc[debit], debit: amount }, { accountId: acc[credit], credit: amount }] }));
  await journal(`${P[0]}-05`, '1120', '3100', '1000000.00');
  await invoice(alpha, `${P[0]}-10`, '300000.00');
  await journal(`${P[0]}-11`, '5000', '1120', '90000.00');
  await invoice(alpha, `${Q[0]}-10`, '120000.00');
  await invoice(beta, `${Q[1]}-10`, '80000.00');
  await journal(`${Q[1]}-12`, '5000', '1120', '100000.00');
  await journal(`${Q[2]}-12`, '6200', '1120', '160000.00');

  await Promise.all([page.waitForResponse((r) => r.url().includes('/stakeholder-reports/executive/') && r.ok()), page.goto(`${base}/reports/executive`)]);
  await page.getByRole('heading', { name: `Executive report, ${qLabel(Q[0])}` }).waitFor();
  const pl = await page.getByRole('table', { name: 'Summary profit and loss' }).innerText();
  assert.match(pl, /Revenue\s+₹2,00,000\.00\s+₹3,00,000\.00\s+-33\.3%/);
  assert.match(pl, /Net income\s+-₹60,000\.00/);
  const attention = page.getByText('A net loss of 60000.00');
  await attention.waitFor();
  assert.equal(await page.getByText('Gross margin fell 20.0 points, from 70.0% to 50.0%').count(), 1);
  assert.equal(await page.getByText('Alpha Retail brought 60.0% of revenue').count(), 1);
  assert.match(await page.getByRole('table', { name: 'Top customers in the period' }).innerText(), /Alpha Retail[\s\S]*1,20,000\.00[\s\S]*Beta Foods/);
  assert.equal(await page.getByRole('table', { name: 'Months in the period' }).locator('tbody tr').count(), 3);

  await page.getByLabel('Highlights').fill('Two new retail customers.');
  await page.getByLabel('Decisions needed').fill('Approve the price rise.');
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/narrative') && r.ok()), page.getByRole('button', { name: 'Save narrative' }).click()]);
  await page.getByText('Last saved by Esha Executive.').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/executive-report.png`, fullPage: true });
  await page.getByRole('button', { name: 'Finalise report' }).click();
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/finalise') && r.ok()), page.getByRole('dialog').getByRole('button', { name: 'Finalise' }).click()]);
  await page.getByText('Finalised by Esha Executive', { exact: false }).waitFor();
  assert.equal(await page.getByText('Approve the price rise.').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Save narrative' }).count(), 0);

  await Promise.all([page.waitForResponse((r) => r.url().includes('/stakeholder-reports/investor/') && r.ok()), page.goto(`${base}/reports/investor`)]);
  await page.getByRole('heading', { name: `Investor report, ${qLabel(Q[0])}` }).waitFor();
  await page.getByText('Customers are not named in an investor report.').waitFor();
  assert.equal(await page.getByText('Alpha Retail').count(), 0);
  assert.equal(await page.getByText('Points for attention').count(), 0);
  assert.equal(await page.getByLabel('Asks of investors').count(), 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/investor-report.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
