/**
 * Browser end-to-end test for the risk monitor (DASH-036): an owner whose GST returns have gone
 * unfiled opens Reports → Risk monitor, sees the overall score and level, compliance deadlines as
 * the area to look at first with its top findings, the other areas, and today's reading in the
 * trend, then opens the compliance area to act. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
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
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const d = (k) => new Date(Date.parse(`${T}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const gstin = (first14) => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const sum = [...first14].reduce((t, ch, i) => { const v = chars.indexOf(ch) * (i % 2 ? 2 : 1); return t + Math.floor(v / 36) + (v % 36); }, 0);
  return `${first14}${chars[(36 - (sum % 36)) % 36]}`;
};

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner reads the risk monitor and opens the riskiest area', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Rhea Risk');
  await page.getByLabel('Email').fill(`e2e-risk-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Risk Watch Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  ok(await call(`${base}/gst/registration`, { gstin: gstin('27ZZZRM0002Z1Z'), effectiveFrom: `${d(-150).slice(0, 7)}-01` }, 'PUT'), 'gst');
  ok(await call(`${base}/contacts`, { name: 'Unvetted Supplies', isVendor: true }), 'vendor');
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/reports/risk-monitor`);
  await page.getByRole('heading', { name: 'Risk monitor', exact: true }).waitFor();
  const overall = page.getByRole('region', { name: 'Overall risk' });
  await overall.getByRole('img', { name: /Overall risk \d+ out of 100/ }).waitFor();
  await overall.getByText('This is the first reading').waitFor();
  await overall.getByText('Look first at:').getByRole('link', { name: 'Compliance deadlines' }).waitFor();

  const areas = page.getByRole('list', { name: 'Risk areas' });
  assert.equal(await areas.locator(':scope > [role=listitem]').count(), 6);
  const compliance = areas.getByRole('listitem', { name: 'Compliance deadlines' });
  await compliance.getByText('Severe', { exact: true }).waitFor();
  await compliance.getByRole('list', { name: 'Top findings in Compliance deadlines' }).getByText(/GSTR/).first().waitFor();
  await areas.getByRole('listitem', { name: 'Unusual bank activity' }).getByText('Clear', { exact: true }).waitFor();

  const trend = page.getByRole('region', { name: 'Risk over time' });
  await trend.getByRole('img', { name: /Overall risk score and each area's score by day/ }).waitFor();
  assert.equal(await trend.getByRole('table', { name: 'Risk readings by day' }).locator('tbody tr').count(), 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/risk-monitor.png`, fullPage: true });

  await compliance.getByRole('link', { name: 'Open compliance deadlines' }).click();
  await page.waitForURL(/\/tax\/compliance-predictions$/);
  assert.deepEqual(consoleErrors, []);
});
