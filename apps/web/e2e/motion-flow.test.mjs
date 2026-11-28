/**
 * Browser end-to-end test for motion (DASH-038). On a device that asks for reduced motion the app
 * keeps still: pages appear at once and the globe jumps straight to a place. A person who chooses
 * Animate sees pages rise in and the globe glide there through in-between views; choosing Keep
 * still on a device that allows motion stills everything again. Real Next.js app → real API →
 * real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, context, page, orgId;
let consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
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
const motion = () => page.evaluate(() => document.documentElement.dataset.motion);
const enterDuration = () => page.evaluate(() => getComputedStyle(document.getElementById('main')).animationDuration);
/** Watches the globe's grid while Tamil Nadu is chosen; returns how many different drawings were seen. */
async function drawingsWhileChoosing(name) {
  await page.getByRole('img', { name: /^Revenue by where customers are/ }).waitFor();
  await page.evaluate(() => {
    window.__seen = new Set();
    const svg = document.querySelector('[aria-label^="Revenue by where customers are"]');
    window.__watch = new MutationObserver(() => window.__seen.add(svg.querySelector('path')?.getAttribute('d')));
    window.__watch.observe(svg, { subtree: true, attributes: true, childList: true });
  });
  await page
    .getByRole('table', { name: /^Revenue by place/ })
    .getByRole('button', { name, exact: true })
    .click();
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    window.__watch.disconnect();
    return window.__seen.size;
  });
}

before(async () => {
  browser = await chromium.launch();
  // This device asks for reduced motion.
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('the app keeps still or animates as the person and the device ask', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dev Motion');
  await page.getByLabel('Email').fill(`e2e-motion-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Motion Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  for (const [name, stateCode, amount] of [
    ['Pune Motion Mart', '27', '80000.00'],
    ['Chennai Motion Stores', '33', '20000.00'],
  ]) {
    const id = ok(await call(`${base}/contacts`, { name, isCustomer: true, stateCode }), name).id;
    ok(
      await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: id, issueDate: T, dueDate: T, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amount }] }),
      'invoice',
    );
  }
  consoleErrors = [];

  // Following the device (reduced): still.
  await page.goto(`${WEB}/orgs/${orgId}/reports/revenue-globe`);
  await page.getByRole('heading', { name: 'Revenue globe', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.motion);
  assert.equal(await motion(), 'reduced');
  assert.ok(parseFloat(await enterDuration()) < 0.001, await enterDuration());
  assert.equal(await drawingsWhileChoosing('Tamil Nadu'), 1);

  // Choose Animate: pages rise in and the globe glides, even on this device.
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('heading', { name: 'Account and preferences' }).waitFor();
  const card = page.locator('[aria-label="Language and formats"]');
  assert.equal(await card.getByLabel('Motion').inputValue(), 'SYSTEM');
  await card.getByLabel('Motion').selectOption('FULL');
  await card.getByRole('button', { name: 'Save' }).click();
  await card.getByRole('status').getByText('Saved', { exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'full');
  assert.equal(ok(await call('/v1/auth/me'), 'me').preferences.motion, 'FULL');
  await page.getByRole('link', { name: 'Revenue globe' }).click();
  await page.getByRole('heading', { name: 'Revenue globe', exact: true }).waitFor();
  assert.equal(await enterDuration(), '0.32s');
  assert.ok((await drawingsWhileChoosing('Tamil Nadu')) > 3);
  if (SHOTS) await page.getByRole('region', { name: 'Globe', exact: true }).screenshot({ path: `${SHOTS}/motion-globe.png` });

  // The choice is kept: a fresh page on this device still animates.
  await page.reload();
  await page.getByRole('heading', { name: 'Revenue globe', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'full');

  // On a device that allows motion, Keep still stills it again.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  ok(await call('/v1/auth/me/preferences', { language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null, motion: 'REDUCED' }, 'PUT'), 'keep still');
  await page.reload();
  await page.getByRole('heading', { name: 'Revenue globe', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'reduced');
  assert.equal(await drawingsWhileChoosing('Maharashtra'), 1);

  // Following the device again, on a device that allows motion: it animates.
  ok(await call('/v1/auth/me/preferences', { language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null, motion: 'SYSTEM' }, 'PUT'), 'follow device');
  await page.reload();
  await page.getByRole('heading', { name: 'Revenue globe', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'full');

  assert.deepEqual(consoleErrors, []);
});
