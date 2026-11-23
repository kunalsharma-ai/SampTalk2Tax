/**
 * Browser end-to-end test for tax notice analysis (TAX-050): an owner records a GST scrutiny
 * notice by its form name, sees what it is, the usual reply deadline and how to reply, ticks the
 * checklist, and on an income-tax demand sees the interest building up; on a show cause notice
 * known only by its form, chooses the type. Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(`${T}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a tax notice is analysed: type, deadline, how to reply, checklist and interest', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Notices');
  await page.getByLabel('Email').fill(`e2e-notice-analysis-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Noticed Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const scrutiny = await must(call(`${B}/tax-notices`, { authority: 'GST', reference: 'ZD-SYN-0001', section: 'ASMT-10', subject: 'Mismatch between GSTR-1 and GSTR-3B (synthetic)', period: '2025-26', receivedOn: day(-10), demand: '48250.00' }));
  const scn = await must(call(`${B}/tax-notices`, { authority: 'GST', reference: 'ZD-SYN-0002', section: 'DRC-01', subject: 'Show cause notice (synthetic)', period: '2025-26', receivedOn: day(-5) }));
  const demand = await must(call(`${B}/tax-notices`, { authority: 'INCOME_TAX', reference: 'CPC-SYN-156', section: '156', subject: 'Demand after processing (synthetic)', receivedOn: day(-70), demand: '125000.00' }));
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/notices/${scrutiny.id}`);
  const analysis = page.getByRole('region', { name: 'Notice analysis' });
  await analysis.getByText('Scrutiny of returns (ASMT-10)').first().waitFor();
  const text = await analysis.innerText();
  assert.match(text, /From the section[\s\S]*How to reply: Reply in ASMT-11[\s\S]*Source: CGST Act, 2017, s\.61; CGST Rules, rule 99/);
  assert.match(text, /Reply by .* \(the usual 30 days from receipt\)/);
  assert.match(text, /Other notices from this authority for the same period[\s\S]*ZD-SYN-0002/);
  const list = analysis.getByRole('list', { name: 'Notice checklist' });
  await list.getByLabel('Reconcile outward supplies between GSTR-1 and GSTR-3B for the period').click();
  await analysis.getByText('(1 of 5 done)').waitFor();
  await list.getByLabel('Reconcile input tax credit claimed with GSTR-2B').click();
  await analysis.getByText('(2 of 5 done)').waitFor();
  await analysis.getByText('Last ticked by Tara Notices.').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-notice-analysis.png`, fullPage: true });
  await page.reload();
  await analysis.getByText('(2 of 5 done)').waitFor();
  assert.equal(await list.getByLabel('Reconcile input tax credit claimed with GSTR-2B').isChecked(), true);

  await page.goto(`${base}/tax/notices/${demand.id}`);
  await analysis.getByText('Notice of demand').first().waitFor();
  assert.match(await analysis.innerText(), /Interest is building up on the demand[\s\S]*1% a month for \d+ months? from/);

  await page.goto(`${base}/tax/notices/${scn.id}`);
  await analysis.getByText(/Section DRC-01 is not one this analysis knows/).waitFor();
  await analysis.getByLabel('Notice type').selectOption('GST_74A');
  await analysis.getByText('Type chosen').waitFor();
  assert.match(await analysis.innerText(), /Type chosen[\s\S]*Reply in DRC-06/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-notice-analysis-chosen.png`, fullPage: true });
  const saved = await must(call(`${B}/tax-notices/${scn.id}/analysis`));
  assert.equal(saved.chosenType, 'GST_74A');
  assert.deepEqual(consoleErrors, []);
});
