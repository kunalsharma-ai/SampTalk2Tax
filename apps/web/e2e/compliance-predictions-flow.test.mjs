/**
 * Browser end-to-end test for compliance deadline predictions (TAX-047): an organisation registered
 * for GST four months ago filed GSTR-1 three days late every month and GSTR-3B five days early, and
 * last month a manual journal moved Output IGST. The Deadline risk page marks GSTR-1 likely late,
 * shows its record, and warns that last month's GST accounts differ from its documents.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const monthOf = (back) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const fiscalYear = (m) => (Number(m.slice(5, 7)) >= 4 ? Number(m.slice(0, 4)) + 1 : Number(m.slice(0, 4)));
let browser, page;
const consoleErrors = [];

// GSTIN check character (mod-36 Luhn), so the synthetic GSTIN is valid.
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1); // not money
    sum += Math.floor(p / 36) + (p % 36); // not money
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36];
};

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

test('Deadline risk predicts the habitually late return and flags books that are not ready', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Deadline');
  await page.getByLabel('Email').fill(`e2e-deadline-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Deadline Risk Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  for (const fy of new Set([4, 3, 2, 1].map((b) => fiscalYear(monthOf(b))))) await call(`${B}/periods/fiscal-years`, { fiscalYear: fy });
  await must(call(`${B}/gst/registration`, { gstin: gstin('29ZZZDR9001Z1Z'), legalName: 'E2E Deadline Risk Co', effectiveFrom: `${monthOf(4)}-01` }, 'PUT'));
  for (const back of [4, 3, 2]) {
    const m = monthOf(back);
    const n = monthOf(back - 1);
    await must(call(`${B}/compliance/filings`, { key: `GSTR1:${m}`, filedOn: `${n}-14`, reference: `ARN1${back}` }));
    await must(call(`${B}/compliance/filings`, { key: `GSTR3B:${m}`, filedOn: `${n}-15`, reference: `ARN3${back}` }));
  }
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  await must(call(`${B}/journals`, { date: `${monthOf(1)}-20`, post: true, memo: 'IGST correction', lines: [{ accountId: acc['6400'], debit: '500.00' }, { accountId: acc['2312'], credit: '500.00' }] }));
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/compliance-predictions`);
  await page.getByRole('heading', { name: 'Deadline risk' }).waitFor();
  const table = page.getByRole('table', { name: 'Deadlines by risk' });
  await table.waitFor();
  const label = new Date(`${monthOf(1)}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const g1 = table.getByRole('row').filter({ hasText: 'GSTR-1' }).filter({ hasText: label });
  assert.match(await g1.innerText(), /Likely late[\s\S]*Late 3 of 3[\s\S]*Usually 3 days late/);
  const g3 = table.getByRole('row').filter({ hasText: 'GSTR-3B' }).filter({ hasText: label });
  assert.match(await g3.innerText(), /The GST accounts and .* documents differ \(1 item to explain\)[\s\S]*Usually 5 days early/);
  // The first row is the most at risk.
  assert.match(await table.getByRole('row').nth(1).innerText(), /Likely late/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/compliance-predictions.png`, fullPage: true });

  // Looking further ahead brings in more deadlines.
  const rows60 = await table.getByRole('row').count();
  await page.getByLabel('Days ahead').selectOption('120');
  await page.waitForFunction((n) => document.querySelectorAll('table[aria-label="Deadlines by risk"] tr').length > n, rows60);
  assert.deepEqual(consoleErrors, []);
});
