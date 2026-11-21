/**
 * Browser end-to-end test for organisation setup (UX-004 to UX-019): a new owner sees the setup
 * prompt on the dashboard, fills the business profile from the suggestions, sees the AI choice
 * reach the AI control center, saves the GST registration from the checklist, and activates the
 * organisation. Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

async function call(path, method = 'GET', body) {
  return page.evaluate(
    async ([u, m, b]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'x-t2t-csrf': '1', ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, method, body],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a new organisation is set up from the checklist and activated', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Sana Setup');
  await page.getByLabel('Email').fill(`e2e-setup-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Setup Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();

  // The dashboard asks to finish setup.
  await page.getByText('Finish setting up').waitFor();
  await page.getByRole('link', { name: 'Open the setup checklist' }).click();
  await page.waitForURL(/\/setup$/);
  await page.getByRole('heading', { name: 'Set up your organisation' }).waitFor();
  await page.getByText('Finish the required steps first').waitFor();

  await page.getByLabel('Industry').selectOption('SOFTWARE');
  await page.getByLabel('Business size').selectOption('MICRO');
  await page.getByRole('button', { name: 'Use the suggestions' }).click();
  assert.equal(await page.getByLabel('Accounting framework').inputValue(), 'INDIAN_GAAP');
  assert.equal(await page.getByLabel('AI agents').inputValue(), 'PREPARE');
  await page.getByLabel('AI agents').selectOption('ADVISE');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByText('Profile saved.').waitFor();
  const ai = (await call(`/v1/orgs/${orgId}/ai-control`)).body;
  assert.deepEqual(Object.fromEntries(ai.agents.map((a) => [a.key, a.enabled])), { COPILOT: true, COLLECTIONS: false, BANKING: false, CLOSE: false, CFO: true });

  // Only GST is left among the required steps; the checklist links to it.
  await page.getByText('Finish the required steps first').waitFor();
  await page.getByRole('row', { name: /GST registration/ }).getByRole('link', { name: 'Go there' }).waitFor();
  await shot('setup-checklist');
  const fy = (await call(`/v1/orgs/${orgId}/periods`)).body.map((p) => p.startDate).sort()[0];
  const r = await call(`/v1/orgs/${orgId}/gst/registration`, 'PUT', { gstin: '27AAPFU0939F1ZV', effectiveFrom: fy });
  assert.equal(r.status, 200);

  await page.reload();
  await page.getByRole('button', { name: 'Activate organisation' }).click();
  await page.getByText('Organisation active').waitFor();
  await shot('setup-activated');
  await page.goto(`${WEB}/orgs/${orgId}`);
  await page.getByText('Net income YTD').waitFor().catch(async (e) => { await page.screenshot({ path: '/tmp/claude-0/shots/setup-debug.png' }); throw e; });
  assert.equal(await page.getByText('Finish setting up').count(), 0);
  assert.deepEqual(consoleErrors, []);
});
