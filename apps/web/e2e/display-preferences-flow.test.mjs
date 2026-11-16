/**
 * Browser end-to-end test for languages and regional formats: a person switches the interface to
 * Hindi with international numbers, ISO dates and their own time zone, sees the navigation, an
 * invoice list and the account page change, the owner changes the organisation's time zone, and
 * the person switches back to English. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, orgId, base, accounts;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
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

test('a person reads Talk2Tax in Hindi with their own formats, and the organisation time zone is set', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Format Owner');
  await page.getByLabel('Email').fill(`e2e-formats-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Formats Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${base}/contacts`, { name: 'Format Buyer', isCustomer: true })).body;
  const inv = await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, dueDate: T, post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: '1234567.89' }] });
  assert.equal(inv.status, 201);

  // Defaults: English, Indian grouping for INR, "06 Nov 2026" dates.
  await page.goto(`${WEB}/orgs/${orgId}/sales/invoices`);
  await page.getByText('₹12,34,567.89').first().waitFor();
  const [y, m, d] = T.split('-');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1];
  await page.getByText(`${d} ${MON} ${y}`).first().waitFor();

  // Choose Hindi, international numbers, ISO dates and London time.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('heading', { name: 'Account and preferences' }).waitFor();
  const card = page.locator('[aria-label="Language and formats"]');
  await card.getByLabel('Language').selectOption('hi');
  await card.getByLabel('Number format').selectOption('INTL');
  await card.getByLabel('Date format').selectOption('YMD');
  await card.getByLabel('Time zone').selectOption('Europe/London');
  assert.match(await page.getByTestId('preferences-preview').innerText(), /₹1,234,567\.89 · 2026-03-31 · \d{4}-\d{2}-\d{2}, \d{2}:\d{2}/);
  await card.getByRole('button', { name: 'Save' }).click();

  // The interface is now in Hindi, and html says so.
  const nav = page.getByRole('navigation', { name: 'मुख्य' });
  await nav.getByRole('link', { name: 'डैशबोर्ड', exact: true }).waitFor();
  await nav.getByRole('link', { name: 'इनवॉइस', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'खाता और प्राथमिकताएँ' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'hi');
  await page.getByRole('link', { name: 'खाता', exact: true }).waitFor();
  await page.getByRole('button', { name: 'साइन आउट' }).waitFor();
  const me = (await call('/v1/auth/me')).body.preferences;
  assert.deepEqual(me, { language: 'hi', numberFormat: 'INTL', dateFormat: 'YMD', timeZone: 'Europe/London' });

  // Figures and dates follow the person's formats; the amount is the same.
  await nav.getByRole('link', { name: 'इनवॉइस', exact: true }).click();
  await page.getByText('₹1,234,567.89').first().waitFor();
  await page.getByText(T).first().waitFor();

  // The owner sets the organisation's time zone.
  await page.goto(`${WEB}/orgs/${orgId}/account`);
  const tzCard = page.locator('[aria-label="संगठन का समय क्षेत्र"]');
  await tzCard.getByLabel('समय क्षेत्र').selectOption('Asia/Dubai');
  await tzCard.getByRole('button', { name: 'सहेजें' }).click();
  // Saving redraws the page in the new zone; the choice stays selected.
  await page.waitForFunction(() => document.querySelector('[aria-label="संगठन का समय क्षेत्र"] select')?.value === 'Asia/Dubai' && !document.querySelector('[aria-label="संगठन का समय क्षेत्र"] button:not([disabled])'));
  assert.equal((await call(base)).body.timeZone, 'Asia/Dubai');

  // Back to English.
  const prefs = page.locator('[aria-label="भाषा और प्रारूप"]');
  await prefs.getByLabel('भाषा').selectOption('en');
  await prefs.getByRole('button', { name: 'सहेजें' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  // The time zone choice now offers the organisation's new zone.
  await page.locator('[aria-label="Language and formats"]').getByLabel('Time zone').locator('option', { hasText: "The organisation's (Asia/Dubai)" }).waitFor({ state: 'attached' });

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), []);
});
