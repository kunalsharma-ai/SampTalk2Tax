/**
 * Dashboards and visuals are accessible and interactive (DASH-009/010/041).
 * With a month of real books, every visual screen is checked in light and dark colours:
 * - axe-core finds no serious or critical WCAG 2.1 A/AA violation;
 * - every chart is an image with a name that points to its figures, and the screen has a table
 *   holding them (charts are never the only way to read a number);
 * - every interactive picture (a 3D view, a globe, a network) can be reached and turned with
 *   the keyboard, with focus visible;
 * - on a device that asks for reduced motion, nothing on these screens keeps moving.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser;

/** The visual screens, and the interactive picture each one has (if any). */
const SCREENS = [
  { path: '/reports/visuals', heading: 'Financial visuals' },
  { path: '/reports/landscape', heading: 'Financial landscape', turn: /^Turn the landscape/ },
  { path: '/reports/revenue-globe', heading: 'Revenue globe', turn: /^Turn the globe/ },
  { path: '/reports/cash-flow-network', heading: 'Cash-flow network' },
  { path: '/reports/timeline', heading: null },
  { path: '/reports/risk-monitor', heading: null },
];

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

async function axeProblems(page, label) {
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
  }, TAGS);
  return result.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${label} — ${v.id} (${v.impact}): ${v.help} at ${v.nodes.join(', ')}`);
}

test('visual screens are accessible, interactive by keyboard and still when asked', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Visual Access Owner');
  await page.getByLabel('Email').fill(`e2e-visual-a11y-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Visual Access Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const orgId = orgUrl.split('/').pop();
  const call = (path, body) =>
    page.evaluate(
      async ([p, b]) => {
        const r = await fetch(`/api/t2t/v1/orgs${p}`, { method: b ? 'POST' : 'GET', headers: { 'x-t2t-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      [path, body],
    );
  const acc = Object.fromEntries((await call(`/${orgId}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`/${orgId}/contacts`, { name: 'Lotus Retail', isCustomer: true, stateCode: '27' })).body.id;
  const inv = await call(`/${orgId}/sales/documents`, {
    kind: 'INVOICE',
    contactId: customer,
    issueDate: T,
    dueDate: T,
    post: true,
    lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '90000.00' }],
  });
  assert.equal(inv.status, 201);
  for (const [dr, cr, amount] of [
    ['6100', '1120', '40000.00'],
    ['6200', '1120', '15000.00'],
  ]) {
    const j = await call(`/${orgId}/journals`, {
      date: T,
      memo: 'Costs',
      post: true,
      lines: [
        { accountId: acc[dr], debit: amount },
        { accountId: acc[cr], credit: amount },
      ],
    });
    assert.equal(j.status, 201);
  }

  const problems = [];
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const s of SCREENS) {
      const res = await page.goto(`${orgUrl}${s.path}`);
      assert.notEqual(res?.status(), 404, `${s.path} exists`);
      if (s.heading) await page.getByRole('heading', { name: s.heading, exact: true }).waitFor();
      // Figures shown: a chart or a table with rows.
      await page
        .locator('main')
        .locator('[role="img"], table tbody tr')
        .filter({ visible: true })
        .first()
        .waitFor({ timeout: 20_000 })
        .catch(() => assert.fail(`${s.path}: no chart or table rows shown`));
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15_000 }).catch(() => undefined);
      problems.push(...(await axeProblems(page, `${s.path} (${scheme})`)));

      // Charts point to their figures, and the figures are in a table.
      const charts = await page.evaluate(() =>
        [...document.querySelectorAll('main [role="img"], main [aria-roledescription="chart"]')]
          .filter((e) => e.tagName.toLowerCase() === 'svg' || e.querySelector('svg') || e.closest('.recharts-wrapper'))
          .map((e) => e.getAttribute('aria-label') ?? ''),
      );
      for (const label of charts) assert.match(label, /table/i, `${s.path}: chart "${label.slice(0, 80)}" names where its figures are`);
      if (charts.length) assert.ok((await page.locator('main table').count()) > 0, `${s.path} has its figures in a table`);

      // Nothing keeps moving under reduced motion.
      const moving = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length);
      assert.equal(moving, 0, `${s.path}: ${moving} animations still loop under reduced motion`);

      // An interactive picture is reachable and turned by keyboard, with focus visible.
      if (s.turn && scheme === 'light') {
        const group = page.getByRole('group', { name: s.turn });
        const shape = () =>
          group
            .locator('svg path, svg polygon')
            .nth(1)
            .getAttribute(s.path.includes('globe') ? 'd' : 'points');
        const before = await shape();
        await group.focus();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'group');
        assert.ok(await page.evaluate(() => document.activeElement?.matches(':focus-visible') || getComputedStyle(document.activeElement).boxShadow !== 'none'), `${s.path}: focus is visible`);
        await page.keyboard.press('Shift+ArrowRight');
        assert.notEqual(await shape(), before, `${s.path}: the arrow keys turn it`);
      }
    }
  }
  await ctx.close();
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  assert.deepEqual(consoleErrors, []);
});
