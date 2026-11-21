/**
 * Browser end-to-end test for report templates (RPT-030) and design version history (RPT-039):
 * the owner starts a design from a template, saves a change, views the first version and
 * restores it as a new version. Real Next.js app → real API → real MongoDB.
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

test('a design starts from a template and an earlier version is restored', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Templates');
  await page.getByLabel('Email').fill(`e2e-templates-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Templates Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();

  await page.goto(`${WEB}/orgs/${orgId}/reports/designer`);
  await page.getByRole('heading', { name: 'Report templates' }).waitFor();
  await shot('report-templates');
  await page.getByRole('button', { name: 'Use template: Cash and collections' }).click();
  await page.waitForURL(/\/reports\/designer\/[0-9a-f-]{36}$/);
  const designId = page.url().split('/').pop();
  await page.getByRole('heading', { name: /Cash and collections/ }).waitFor();
  const versions = page.getByRole('table', { name: 'Design versions' });
  await versions.getByText('From a template').waitFor();

  const v1 = (await call(`/v1/orgs/${orgId}/report-designer/designs/${designId}/versions/1`)).body;
  const r = await call(`/v1/orgs/${orgId}/report-designer/designs/${designId}`, 'PUT', { name: 'Cash report', layout: { sections: v1.layout.sections.slice(0, 2) }, baseVersion: 1 });
  assert.equal(r.status, 200);
  await page.reload();
  await page.getByRole('heading', { name: /Cash report/ }).waitFor();
  await versions.getByText('Edited').waitFor();

  await page.getByRole('button', { name: 'View version 1' }).click();
  const shown = page.getByRole('list', { name: 'Sections of version 1' });
  await shown.waitFor();
  assert.equal(await shown.getByRole('listitem').count(), v1.layout.sections.length);
  await page.getByRole('button', { name: 'Restore version 1' }).click();
  await versions.getByText('Restored from v1').waitFor();
  await page.getByRole('heading', { name: /Cash and collections/ }).waitFor();
  assert.equal(await versions.getByRole('row').count(), 4);
  await shot('report-design-versions');
  assert.deepEqual(consoleErrors, []);
});
