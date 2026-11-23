/**
 * Browser end-to-end test for tax audit preparation (TAX-051): an owner sees what is missing for
 * the last financial year (open months, a draft journal, no income tax computation) and what needs
 * attention (cash payments over 10,000 in a day, the year not closed), fixes what is missing,
 * explains the rest in notes for the auditor and marks the year ready. Real Next.js app, API and
 * MongoDB.
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
// The last financial year runs from 1 April P to 31 March P+1.
const P = Number(T.slice(0, 4)) - (T.slice(5) < '04-01' ? 1 : 0) - 1;
const LAST = `${P}-${String(P + 1).slice(2)}`;

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

test('the year is prepared for the tax auditor: fixed, explained and marked ready', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Tara Preparer');
  await page.getByLabel('Email').fill(`e2e-preparation-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Prepared Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  await call(`${B}/periods/fiscal-years`, { fiscalYear: P + 1 });
  const acc = Object.fromEntries((await must(call(`${B}/accounts`))).map((a) => [a.code, a.id]));
  const journal = (date, debit, credit, amount, post = true) => must(call(`${B}/journals`, { date, post, memo: 'Preparation flow', lines: [{ accountId: acc[debit], debit: amount }, { accountId: acc[credit], credit: amount }] }));
  await journal(`${P}-05-05`, '1120', '4100', '2000000.00');
  const draft = await journal(`${P}-11-11`, '6600', '1120', '1000.00', false);
  const kirana = (await must(call(`${B}/contacts`, { name: 'Local Kirana', isVendor: true }))).id;
  for (const amount of ['6000.00', '5000.00']) await must(call(`${B}/purchases/payments`, { contactId: kirana, date: `${P}-06-03`, bankAccountId: acc['1110'], amount, allocations: [] }));
  consoleErrors.length = 0;

  await page.goto(`${base}/tax/audit-preparation`);
  const checks = page.getByRole('table', { name: 'Readiness checks' });
  await checks.waitFor();
  assert.equal(await page.getByLabel('Financial year').inputValue(), LAST);
  const row = (title) => checks.locator('tbody tr').filter({ hasText: title });
  assert.match(await row('Months of the year locked').innerText(), /Missing[\s\S]*12 months of 12 still open/);
  assert.match(await row('No drafts dated in the year').innerText(), /Missing[\s\S]*1 draft journal/);
  assert.match(await row('Cash payments over 10,000 a day').innerText(), /Clause 21\(d\)[\s\S]*Needs attention[\s\S]*11000\.00/);
  assert.match(await row('Income tax computation').innerText(), /Missing[\s\S]*has not been prepared/);
  assert.equal(await page.getByRole('button', { name: 'Mark ready for the auditor' }).isDisabled(), true);
  assert.match(await page.getByRole('list', { name: 'What stops the year being ready' }).innerText(), /Months of the year locked[\s\S]*Cash payments over 10,000 a day: add a note for the auditor or fix it/);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-audit-preparation.png`, fullPage: true });

  // Fix what is missing elsewhere in the app.
  await must(call(`${B}/journals/${draft.id}/post`, {}));
  await must(call(`${B}/tax/income-computation/${LAST}`, { regime: 'COMPANY_22', taxDepreciation: '0', broughtForwardLoss: '0', adjustments: [], otherCredits: '0' }, 'PUT'));
  await must(call(`${B}/tax/income-computation/${LAST}/finalise`, {}));
  for (const p of (await must(call(`${B}/periods?fiscalYear=${P + 1}`))).filter((x) => x.status === 'OPEN')) await must(call(`${B}/periods/${p.id}/lock`, {}));
  await page.reload();
  await checks.waitFor();
  assert.match(await row('Months of the year locked').innerText(), /Ready/);

  // Explain what needs attention.
  await page.getByRole('button', { name: 'Add note on Cash payments over 10,000 a day' }).click();
  await page.getByLabel('Note on Cash payments over 10,000 a day').fill('Paid to a farmer for produce: rule 6DD(e) applies.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await row('Cash payments over 10,000 a day').getByText('Tara Preparer').waitFor();
  await page.getByRole('button', { name: 'Add note on Year closed to retained earnings' }).click();
  await page.getByLabel('Note on Year closed to retained earnings').fill('Closing after the audit adjustments.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.getByText('Nothing stops it: the year can be marked ready for the auditor.').waitFor();

  await page.getByRole('button', { name: 'Mark ready for the auditor' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark ready', exact: true }).click();
  await page.getByText('Ready for the auditor', { exact: true }).waitFor();
  assert.match(await row('Cash payments over 10,000 a day').innerText(), /Paid to a farmer for produce: rule 6DD\(e\) applies\./);
  assert.equal(await page.getByRole('button', { name: 'Edit note on Cash payments over 10,000 a day' }).count(), 0);
  const saved = await must(call(`${B}/tax/audit-preparation?year=${LAST}`));
  assert.equal(saved.status, 'READY');
  assert.deepEqual(saved.ready.summary, { ready: 4, attention: 2, missing: 0, notApplicable: 5 });
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tax-audit-preparation-ready.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
