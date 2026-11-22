/**
 * Browser end-to-end test for unusual expenses and fraud risk indicators (EXP-023, EXP-024): an
 * owner submits a meal receipt twice (once with an old taxi receipt) and a large claim with no
 * receipts attached; Unusual expenses lists the claims most serious first with what each sign was
 * raised on, ranks the claimant, can look at a shorter period, and a claim opens from the list.
 * Real Next.js app → real API → real MongoDB.
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
const iso = (n) => new Date(Date.parse(`${T}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
// n days ago, a day earlier when that is a Sunday, so no Sunday sign appears.
const day = (n) => (new Date(`${iso(n)}T00:00:00Z`).getUTCDay() === 0 ? iso(n + 1) : iso(n));

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

test('claims with warning signs are listed with who made them', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Esha Expenses');
  await page.getByLabel('Email').fill(`e2e-expense-risk-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Expense Risk Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const accounts = (await call(`${B}/accounts`)).body;
  const acc = Object.fromEntries((accounts.accounts ?? accounts).map((a) => [a.code, a.id]));
  const submit = async (title, lines) => {
    const c = await must(call(`${B}/expense-claims`, { title, lines }));
    await must(call(`${B}/expense-claims/${c.id}/submit`, {}));
    return c;
  };
  const first = await submit('Client lunch', [{ date: day(40), accountId: acc['6600'], merchant: 'Cafe Coffee Day', amount: '845.50' }]);
  const second = await submit('Team lunch and taxi', [
    { date: day(40), accountId: acc['6600'], merchant: 'CAFE COFFEE DAY', amount: '845.50' },
    { date: day(120), accountId: acc['6700'], merchant: 'Synthetic Cabs', amount: '640.25' },
  ]);
  await submit('Offsite hotel', [{ date: day(3), accountId: acc['6700'], merchant: 'Synthetic Grand Hotel', amount: '6450.75' }]);

  await page.goto(`${base}/expenses/risk`);
  const table = page.getByRole('table', { name: 'Unusual expense claims' });
  await table.waitFor();
  const text = await table.locator('tbody tr').allInnerTexts();
  assert.equal(text.length, 3);
  assert.match(text[0], new RegExp(`High[\\s\\S]*${second.number}[\\s\\S]*Possible duplicate receipt[\\s\\S]*is also line 1 of ${first.number}, claimed by the same person[\\s\\S]*Old receipt[\\s\\S]*Line 2 is dated more than 60 days before the claim was submitted`));
  assert.match(text[1], new RegExp(`High[\\s\\S]*${first.number}[\\s\\S]*Possible duplicate receipt`));
  assert.match(text[2], /Medium[\s\S]*Offsite hotel[\s\S]*No receipts attached[\s\S]*₹6,450\.75 of receipts claimed with no file attached/);
  const people = await page.getByRole('table', { name: 'Claimants with warning signs' }).locator('tbody tr').allInnerTexts();
  assert.equal(people.length, 1);
  assert.match(people[0], /Esha Expenses\s+3\s+3\s+2\s+2\s+0\s+10/);
  await page.getByText('Claims with warning signs', { exact: true }).first().waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/unusual-expenses.png`, fullPage: true });

  await page.getByLabel('Submitted in').selectOption('30');
  await page.getByText('Of 3 submitted since').waitFor();
  await table.locator('tbody tr').first().getByRole('link', { name: second.number }).click();
  await page.waitForURL(new RegExp(`/expenses/${second.id}$`));
  assert.deepEqual(consoleErrors, []);
});
