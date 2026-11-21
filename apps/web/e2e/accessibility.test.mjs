/**
 * Accessibility tests (QA-018): the main screens, signed out and signed in, are checked with
 * axe-core against WCAG 2.1 levels A and AA, in light and dark colour schemes and on a phone-sized
 * screen. A serious or critical violation fails the test with the rule, the element and how to
 * fix it. Keyboard use is checked too: the sign-in form works with the keyboard alone, and focus
 * is visible. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
let browser;

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

/** Runs axe on the page as it is now; returns the serious and critical violations, described. */
async function audit(page, label) {
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1).join(' ').trim()}`) }));
  }, TAGS);
  return result.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${label} — ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.join('\n    ')}`);
}

async function settle(page) {
  await page.waitForLoadState('networkidle');
  // Data cards load after the shell; give them a moment, then wait for loaders to go.
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15_000 }).catch(() => undefined);
}

test('signed-out screens meet WCAG 2.1 AA', async () => {
  const problems = [];
  for (const scheme of ['light', 'dark']) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme })).newPage();
    for (const path of ['/login', '/register']) {
      const res = await page.goto(`${WEB}${path}`);
      if (res?.status() === 404) continue;
      await settle(page);
      problems.push(...(await audit(page, `${path} (${scheme})`)));
    }
    await page.context().close();
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('the sign-in form works with the keyboard alone, with focus visible', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const email = `e2e-a11y-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Keyboard Person');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.context().clearCookies();
  await page.goto(`${WEB}/login`);
  await settle(page);
  // Tab to the email field, then type and move on with Tab and Enter only.
  let guard = 0;
  while ((await page.evaluate(() => document.activeElement?.getAttribute('type'))) !== 'email' && guard++ < 20) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'email', 'The email field is reachable with Tab');
  // Focus can be seen: an outline or a ring (box-shadow) on the focused field.
  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
  });
  assert.ok(ring, 'The focused field shows a focus outline or ring');
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type('e2e-very-long-password');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.context().close();
});

test('the main signed-in screens meet WCAG 2.1 AA, light and dark, desktop and phone', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const email = `e2e-a11y-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Access Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Accessible Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const orgId = orgUrl.split('/').pop();
  // Some records, so lists and reports have rows to show.
  const api = (path, body) =>
    page.evaluate(async ([p, b]) => {
      const r = await fetch(`/api/t2t/v1${p}`, { method: b ? 'POST' : 'GET', headers: { 'x-t2t-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [path, body]);
  const accounts = (await api(`/orgs/${orgId}/accounts`)).body;
  const acc = Object.fromEntries((Array.isArray(accounts) ? accounts : accounts.accounts ?? accounts.items).map((a) => [a.code, a.id]));
  const customer = (await api(`/orgs/${orgId}/contacts`, { name: 'Banyan Retail', isCustomer: true })).body;
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const inv = await api(`/orgs/${orgId}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: today, dueDate: today, post: true, lines: [{ accountId: acc['4100'], quantity: '2', unitPrice: '1500.00' }] });
  assert.equal(inv.status, 201);

  const screens = [
    '',
    '/sales/invoices',
    `/sales/invoices/${inv.body.id}`,
    '/sales/customers',
    '/purchases/bills',
    '/journals',
    '/accounts',
    '/banking',
    '/reports/income-statement',
    '/reports/balance-sheet',
    '/reports/trial-balance',
    '/tasks',
    '/members',
    '/settings/access-rules',
    '/copilot',
    '/payroll/employees',
    '/expenses',
    '/approvals',
    '/automations',
    '/close',
    '/ai-control',
    '/settings/gst',
    '/sales/invoices/new',
  ];
  const problems = [];
  for (const { scheme, width, height } of [
    { scheme: 'light', width: 1440, height: 900 },
    { scheme: 'dark', width: 1440, height: 900 },
    { scheme: 'light', width: 390, height: 844 },
  ]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height });
    for (const s of width < 500 ? screens.slice(0, 4) : screens) {
      const res = await page.goto(`${orgUrl}${s}`);
      assert.notEqual(res?.status(), 404, `${s} exists`);
      await settle(page);
      problems.push(...(await audit(page, `${s || '/'} (${scheme}, ${width}px)`)));
    }
  }
  await ctx.close();
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});
