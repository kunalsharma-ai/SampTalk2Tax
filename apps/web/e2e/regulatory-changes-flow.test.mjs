/**
 * Browser end-to-end test for regulatory change monitoring (TAX-046): a German company opens Tax →
 * Regulatory changes, sees the e-invoicing changes for Germany and the rules Talk2Tax uses with
 * when they were checked, and records how it dealt with the 2027 change. Real Next.js app → real
 * API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => {
  const r = await p;
  assert.ok(r.status < 300, JSON.stringify(r));
  return r.body;
};

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a German company reviews regulatory changes', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Greta Gesetz');
  await page.getByLabel('Email').fill(`e2e-regchanges-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Country').selectOption('DE');
  await page.getByLabel('Organisation name').fill('E2E Regeln GmbH');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  consoleErrors = [];

  await page.getByRole('link', { name: 'Regulatory changes', exact: true }).click();
  await page.waitForURL(new RegExp(`/orgs/${orgId}/tax/regulatory-changes$`));
  await page.getByRole('heading', { name: 'Regulatory changes', exact: true }).waitFor();
  const changes = page.getByRole('table', { name: 'Law changes for your country' });
  await changes.getByRole('row', { name: /E-invoices required for businesses with turnover above €800,000/ }).waitFor();
  await changes.getByRole('row', { name: /Every business must be able to receive e-invoices .* In force/ }).waitFor();
  await page
    .getByRole('table', { name: 'Rules Talk2Tax uses' })
    .getByRole('row', { name: /Germany country module/ })
    .waitFor();

  await page.getByLabel('How you dealt with it (DE-EINVOICE-ISSUE-2027)').fill('Our bank portal sends XRechnung');
  const row = changes.getByRole('row', { name: /E-invoices required for businesses with turnover above €800,000/ });
  await row.getByRole('button', { name: 'Mark dealt with' }).click();
  await row.getByText('Dealt with', { exact: true }).waitFor();
  await row.getByText(/Greta Gesetz, .*: Our bank portal sends XRechnung/).waitFor();
  const saved = await must(call(`/v1/orgs/${orgId}/tax/regulatory-changes`));
  assert.equal(saved.changes.find((c) => c.key === 'DE-EINVOICE-ISSUE-2027').status, 'DEALT_WITH');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/regulatory-changes.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
