/**
 * Browser end-to-end test for the report designer: an owner with posted invoices designs a
 * monthly report (heading, fixed text, figures, commentary), produces it for a month, writes the
 * commentary (a number not in the report is flagged), finalises it, and the record cannot change.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));
const L = shift(T.slice(0, 7), -1);
const P = shift(L, -1);
const label = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
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

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => browser?.close());

test('an accountant designs a monthly report, produces it, writes the commentary and finalises it', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Rhea Reports');
  await page.getByLabel('Email').fill(`e2e-report-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Report Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const years = new Set(ok(await call(`${base}/periods`), 'periods').map((p) => p.fiscalYear));
  for (const m of [P, L]) if (!years.has(fyOf(m))) ok(await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(m) }), 'fiscal year'), years.add(fyOf(m));
  const acc = Object.fromEntries(ok(await call(`${base}/accounts`), 'accounts').map((a) => [a.code, a.id]));
  const acme = ok(await call(`${base}/contacts`, { name: 'Acme Retail', isCustomer: true }), 'customer').id;
  for (const [d, amt] of [[`${P}-10`, '100000.00'], [`${L}-10`, '250000.00']]) ok(await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: acme, issueDate: d, dueDate: d, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: amt }] }), 'invoice');

  await page.goto(`${WEB}/orgs/${orgId}/reports/designer`);
  await page.getByText('No report designs yet').waitFor();
  await page.getByRole('link', { name: 'New report design' }).click();
  await page.getByRole('region', { name: 'Describe the report' }).waitFor();
  await page.getByLabel('Report name').fill('Monthly board report');
  await page.getByRole('button', { name: 'Add heading' }).click();
  await page.getByLabel('Section 1 heading').fill('Sales');
  await page.getByRole('button', { name: 'Add figure' }).click();
  await page.getByLabel('Section 2 title').fill('Revenue');
  await page.getByRole('button', { name: 'Add commentary' }).click();
  await page.getByLabel('Section 3 commentary instruction').fill('Explain how revenue moved against the month before');
  await page.getByRole('button', { name: 'Add fixed text' }).click();
  await page.getByLabel('Section 4 text').fill('Prepared for the board by the finance team.');
  // Put the text under the heading.
  await page.getByRole('group', { name: 'Section 4' }).getByRole('button', { name: 'Up' }).click();
  await page.getByRole('group', { name: 'Section 3' }).getByRole('button', { name: 'Up' }).click();
  assert.equal(await page.getByLabel('Section 2 text').inputValue(), 'Prepared for the board by the finance team.');
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('region', { name: 'Preview' });
  await preview.getByRole('region', { name: 'Revenue', exact: true }).getByText('₹2,50,000.00').waitFor();
  await preview.getByText('Commentary to be written for the month: Explain how revenue moved').waitFor();
  await page.getByRole('button', { name: 'Save design' }).click();
  await page.waitForURL(/\/reports\/designer\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'RD-0001 · Monthly board report' }).waitFor();
  await page.getByText('No reports produced yet.').waitFor();

  // Produce it for the last complete month; without an AI key the commentary is left to people.
  assert.equal(await page.getByLabel('Month', { exact: true }).inputValue(), L);
  await page.getByRole('button', { name: 'Produce report' }).click();
  await page.waitForURL(/\/reports\/designer\/reports\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: `RPT-0001 · Monthly board report, ${L}` }).waitFor();
  const report = page.getByTestId('report');
  await report.getByRole('heading', { name: 'Sales' }).waitFor();
  await report.getByText('Prepared for the board by the finance team.').waitFor();
  await report.getByRole('region', { name: 'Revenue', exact: true }).getByText('₹2,50,000.00').waitFor();
  await page.getByText('1 commentary section still needs writing.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Finalise' }).isDisabled(), true);

  // A number not in the report is flagged.
  await page.getByLabel('Commentary 4 text').fill('Revenue rose to ₹2,50,000 from ₹90,000.');
  await page.getByRole('button', { name: 'Save commentary 4' }).click();
  await page.getByText(/Numbers not in the report's figures: .*90/).waitFor();
  await page.getByLabel('Commentary 4 text').fill('Revenue rose to ₹2,50,000 from ₹1,00,000, up ₹1,50,000 on the month before.');
  await page.getByRole('button', { name: 'Save commentary 4' }).click();
  await page.getByText(/Numbers not in the report's figures/).waitFor({ state: 'detached' });
  await page.getByText('Every commentary section is written.').waitFor();

  await page.getByRole('button', { name: 'Finalise' }).click();
  await page.getByText('A final report can never be changed or deleted.').waitFor();
  await report.getByText('Revenue rose to ₹2,50,000 from ₹1,00,000').waitFor();
  assert.equal(await page.getByLabel('Commentary 4 text').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Delete' }).count(), 0);
  const final = ok(await call(`${base}/report-designer/reports/${page.url().split('/').pop()}`), 'report');
  assert.equal(final.status, 'FINAL');
  assert.equal(final.commentary[0].source, 'PERSON');

  // The design lists it and can no longer be deleted.
  await page.getByRole('link', { name: 'Monthly board report' }).click();
  await page.getByRole('table', { name: 'Reports' }).getByText('Final').waitFor();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByText(/was produced from this design, so it is kept/).waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/409/.test(e)), []);
});
