/**
 * Browser end-to-end test for the (i) help: a new user sees it on sign-up and onboarding, then on
 * the dashboard, a page title, a section title and the feature guide; it opens and closes with the
 * mouse and the keyboard, and its headings follow the interface language. Real Next.js app → real
 * API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];

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

const pageTip = () => page.getByRole('button', { name: 'About this page' });
const panel = () => page.getByRole('dialog');

test('every page and section explains what it is for, how to use it and where it fits', async () => {
  await page.goto(`${WEB}/register`);
  await pageTip().click();
  await assert.doesNotReject(panel().getByText('What it is for').waitFor());
  assert.match(await panel().innerText(), /Create your Talk2Tax account/);
  await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'detached' });

  await page.getByLabel('Full name').fill('Help Reader');
  await page.getByLabel('Email').fill(`e2e-help-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await pageTip().click();
  assert.match(await panel().innerText(), /Set up your organisation[\s\S]*books are created for you/);
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByLabel('Organisation name').fill('E2E Help Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();

  // The dashboard: the page's own help, closed by a click elsewhere.
  await pageTip().click();
  const dash = await panel().innerText();
  for (const h of ['What it is for', 'How to use it', 'Where it fits']) assert.ok(dash.includes(h.toUpperCase()) || dash.includes(h), h);
  assert.match(dash, /Your organisation at a glance/);
  assert.equal(await pageTip().getAttribute('aria-expanded'), 'true');
  await page.getByRole('heading', { level: 1 }).click();
  await panel().waitFor({ state: 'detached' });
  assert.equal(await pageTip().getAttribute('aria-expanded'), 'false');

  // A section on a page: the revenue forecast's saved forecasts.
  await page.goto(`${base}/sales/revenue-forecast`);
  await page.getByRole('heading', { name: 'Saved forecasts' }).waitFor();
  const section = page.getByRole('heading', { name: 'Saved forecasts' }).locator('xpath=..').getByRole('button', { name: 'About this section' });
  await section.click();
  assert.match(await panel().innerText(), /never changed[\s\S]*error shows how reliable/);
  await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'detached' });
  assert.ok(await section.evaluate((b) => b === document.activeElement), 'focus returns to the (i)');

  // A detail page falls back to the page above it; a page-specific section text wins over the general one.
  await page.goto(`${base}/journals/new`);
  await page.getByRole('heading', { name: 'Lines' }).waitFor();
  await page.getByRole('heading', { name: 'Lines' }).locator('xpath=..').getByRole('button', { name: 'About this section' }).click();
  assert.match(await panel().innerText(), /Debits must equal credits/);
  await page.keyboard.press('Escape');

  // The feature guide lists every menu page with its help, and searches it.
  await page.goto(base);
  await page.getByRole('link', { name: 'Feature guide' }).click();
  await page.waitForURL(/\/guide$/);
  await page.getByRole('heading', { name: 'Feature guide', level: 1 }).waitFor();
  await page.getByRole('heading', { name: 'Governance', level: 2 }).waitFor();
  assert.ok((await page.getByRole('heading', { level: 2 }).count()) >= 8, 'a card per menu group');
  await page.getByLabel('Search the guide').fill('e-way');
  await page.locator('main').getByRole('link', { name: 'E-way bills', exact: true }).waitFor();
  assert.equal(await page.locator('main').getByRole('link', { name: 'Revenue forecast' }).count(), 0);
  await page.getByLabel('Search the guide').fill('zzqqxx');
  await page.getByText('Nothing matches').waitFor();

  // In Hindi, the panel's headings and the menu are translated; the help itself falls back to English.
  assert.equal((await call('/v1/auth/me/preferences', { language: 'hi', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null }, 'PUT')).status, 200);
  await page.goto(`${base}/sales/revenue-forecast`);
  await page.getByRole('button', { name: 'इस पेज के बारे में' }).click();
  const hi = await panel().innerText();
  assert.match(hi, /यह किसलिए है/);
  assert.match(hi, /Revenue still to come|revenue/i);
  await page.keyboard.press('Escape');
  assert.equal((await call('/v1/auth/me/preferences', { language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null }, 'PUT')).status, 200);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
