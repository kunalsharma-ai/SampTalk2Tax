/**
 * Browser end-to-end test for the revenue globe (DASH-025): an owner opens Reports → Revenue
 * globe, sees sales revenue by Indian state and by country as bubbles, turns the globe with the
 * keyboard, zooms into India, plays the months and picks a place from the table.
 * Real Next.js app → real API → real MongoDB.
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
// Today in India, the organisation's time zone; every invoice is dated today.
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner turns the globe to see where revenue comes from', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Globe');
  await page.getByLabel('Email').fill(`e2e-globe-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Globe Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const customer = async (body) => ok(await call(`${base}/contacts`, { isCustomer: true, ...body }), body.name).id;
  const invoice = async (contactId, amount) =>
    ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId, issueDate: T, dueDate: T, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] }), 'invoice');
  await invoice(await customer({ name: 'Pune Traders', stateCode: '27' }), '80000.00');
  await invoice(await customer({ name: 'Chennai Stores', stateCode: '33' }), '20000.00');
  await invoice(await customer({ name: 'London Partners', countryCode: 'GB' }), '50000.00');
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}`);
  await page.getByRole('link', { name: 'Revenue globe' }).click();
  await page.getByRole('heading', { name: 'Revenue globe', exact: true }).waitFor();
  const globe = page.getByRole('region', { name: 'Globe', exact: true });
  await globe.getByRole('img', { name: /^Revenue by where customers are/ }).waitFor();
  const summary = page.getByRole('region', { name: 'Revenue summary' });
  await summary.getByText('₹1,50,000.00', { exact: true }).waitFor();
  await summary.getByText('33.3%', { exact: true }).waitFor();
  await summary.getByText('Maharashtra', { exact: true }).waitFor();
  const table = page.getByRole('region', { name: 'Revenue by place' }).getByRole('table');
  assert.deepEqual(
    (await table.locator('tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()),
    ['Maharashtra State 1 ₹80,000.00 53.3%', 'United Kingdom Country 1 ₹50,000.00 33.3%', 'Tamil Nadu State 1 ₹20,000.00 13.3%', 'Total 3 ₹1,50,000.00 100.0%'],
  );
  assert.ok(!(await page.content()).includes('Pune Traders'));
  if (SHOTS) await globe.screenshot({ path: `${SHOTS}/revenue-globe.png` });

  // Turn it with the keyboard: the grid moves.
  const grid = () => globe.locator('svg path').first().getAttribute('d');
  const was = await grid();
  await globe.getByRole('group', { name: /^Turn the globe/ }).focus();
  await page.keyboard.press('Shift+ArrowRight');
  assert.notEqual(await grid(), was);

  // Zoom into India and pick Tamil Nadu from the table.
  await globe.getByRole('button', { name: 'Zoom to home country' }).click();
  await globe.getByRole('button', { name: 'Whole world' }).waitFor();
  if (SHOTS) await globe.screenshot({ path: `${SHOTS}/revenue-globe-india.png` });
  const tn = table.getByRole('button', { name: 'Tamil Nadu', exact: true });
  await tn.click();
  assert.equal(await tn.getAttribute('aria-pressed'), 'true');
  await globe.locator('svg text', { hasText: 'Tamil Nadu' }).waitFor();

  // Play the months, pause, then go back to all months.
  await globe.getByRole('button', { name: 'Play months' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="globe-period"]')?.textContent !== 'All months');
  await globe.getByRole('button', { name: 'Pause' }).click();
  await globe.getByRole('button', { name: 'All months', exact: true }).click();
  assert.equal(await page.getByTestId('globe-period').textContent(), 'All months');
  await page.getByRole('region', { name: 'Revenue by place' }).getByText('₹1,50,000.00', { exact: true }).waitFor();

  assert.deepEqual(consoleErrors, []);
});
