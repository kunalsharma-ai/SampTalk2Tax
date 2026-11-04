/**
 * Browser end-to-end test for the compliance calendar: a new organisation sees nothing to
 * track, registers for GST from the start of the tax year, sees May's GSTR-1 and GSTR-3B
 * for April, marks GSTR-1 filed with an ARN, voids the record, switches to QRMP in the
 * calendar settings and sees PMT-06 instead, and finds the calendar on the dashboard.
 * Real Next.js app → real API → real PostgreSQL. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const t = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const APR = `${FY}-04`;
const MAY = `${FY}-05`;
const gstin = (state, pan) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
let browser, page, orgId, base;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function call(p, path, body, method = body ? 'POST' : 'GET') {
  return p.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a new organisation has nothing to track until GST is registered', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Compliance Owner');
  await page.getByLabel('Email').fill(`e2e-compliance-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Compliance Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `${WEB}/orgs/${orgId}`;

  await page.getByRole('link', { name: 'Compliance calendar' }).click();
  await page.getByText('Nothing to track yet').waitFor();
  assert.equal((await call(page, `/v1/orgs/${orgId}/gst/registration`, { gstin: gstin('27', 'ZZZCQ0001Z'), effectiveFrom: `${APR}-01` }, 'PUT')).status, 200);
});

test('May shows April GST returns, and GSTR-1 is marked filed and voided', async () => {
  await page.goto(`${base}/tax/compliance?month=${MAY}`);
  const gstr1 = page.getByRole('row', { name: /GSTR-1 \(outward supplies\) April/ });
  const gstr3b = page.getByRole('row', { name: /GSTR-3B \(summary return and tax\) April/ });
  await gstr1.waitFor();
  await gstr3b.waitFor();
  assert.match(await gstr1.textContent(), /11 May/);
  assert.match(await gstr3b.textContent(), /20 May/);

  await gstr1.getByRole('button', { name: /^Mark GSTR-1/ }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Filed on').fill(`${MAY}-10`);
  await d.getByLabel(/Acknowledgement/).fill('AA270526000111A');
  await d.getByRole('button', { name: 'Mark filed' }).click();
  await d.waitFor({ state: 'hidden' });
  await gstr1.getByText('Done', { exact: true }).waitFor();
  await gstr1.getByText('AA270526000111A').waitFor();
  assert.match(await gstr1.textContent(), /Marked filed/);
  await shot(page, 'compliance-may');

  await gstr1.getByRole('button', { name: /^Void filing/ }).click();
  const v = page.getByRole('dialog');
  await v.getByLabel('Reason').fill('Wrong acknowledgement number');
  await v.getByRole('button', { name: 'Void record' }).click();
  await v.waitFor({ state: 'hidden' });
  await gstr1.getByRole('button', { name: /^Mark GSTR-1/ }).waitFor();
  const filings = (await call(page, `/v1/orgs/${orgId}/compliance/filings`)).body;
  assert.deepEqual(filings.map((f) => [f.status, f.reference]), [['VOID', 'AA270526000111A']]);
});

test('switching to QRMP lists PMT-06 for the first months of the quarter', async () => {
  await page.getByRole('button', { name: 'Calendar settings' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('GST returns').selectOption('QUARTERLY');
  await d.getByRole('button', { name: 'Save settings' }).click();
  await d.waitFor({ state: 'hidden' });
  await page.getByRole('row', { name: /GST PMT-06 \(monthly tax under QRMP\) April/ }).waitFor();
  assert.equal(await page.getByRole('row', { name: /GSTR-3B \(summary return and tax\) April/ }).count(), 0);
  assert.ok(await page.getByText('GST QRMP').isVisible());
});

test('the dashboard links to the calendar', async () => {
  await page.goto(base);
  await page.getByRole('heading', { name: 'Compliance' }).waitFor();
  await page.getByRole('link', { name: 'Open calendar' }).click();
  await page.waitForURL(/\/tax\/compliance$/);
  assert.deepEqual(consoleErrors, []);
});
