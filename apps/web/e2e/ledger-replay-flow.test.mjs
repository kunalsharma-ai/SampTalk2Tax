/**
 * Browser end-to-end test for financial transaction replay (AUDIT-017): an owner posts an entry,
 * notes the moment, then posts a back-dated correction; replaying the books at that moment shows
 * the balances as they were, and the correction as the only entry posted since.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser;
const consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

test('the books are replayed as recorded at a past moment, with the entries posted since', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Rhea Replay');
  await page.getByLabel('Email').fill(`e2e-replay-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Replay Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();
  const orgId = orgUrl.split('/').pop();
  const post = (memo, amount, debit, dayOffset) =>
    page.evaluate(
      async ([id, m, a, code, off]) => {
        const accounts = await (await fetch(`/api/t2t/v1/orgs/${id}/accounts`)).json();
        const acc = Object.fromEntries(accounts.map((x) => [x.code, x.id]));
        const day = new Date(Date.now() + 5.5 * 3_600_000 - off * 86_400_000).toISOString().slice(0, 10);
        const r = await fetch(`/api/t2t/v1/orgs/${id}/journals`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ date: day, post: true, memo: m, lines: [{ accountId: acc[code], debit: a }, { accountId: acc['1120'], credit: a }] }) });
        return r.status;
      },
      [orgId, memo, amount, debit, dayOffset],
    );
  assert.equal(await post('Office rent', '30000.00', '6200', 0), 201);
  // The page takes the moment to the minute: wait for the next minute, so the moment (its first
  // second) falls after the rent and before the correction.
  const minute = () => page.evaluate(() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const rentMinute = await minute();
  let moment = rentMinute;
  while (moment === rentMinute) {
    await page.waitForTimeout(1000);
    moment = await minute();
  }
  assert.equal(await post('Bank charges found late', '1200.00', '6900', 0), 201);

  await page.goto(`${orgUrl}/ledger-replay`);
  await page.getByLabel('As recorded at').fill(moment);
  await page.getByRole('button', { name: 'Replay' }).click();
  const balances = page.getByRole('table', { name: 'Balances then and now' });
  await balances.waitFor();
  const rows = await balances.locator('tbody tr').allInnerTexts();
  assert.ok(rows.some((r) => /6900/.test(r) && /1,200\.00/.test(r)), 'the late bank charges are the change');
  assert.ok(rows.some((r) => /6200/.test(r) && /No change/.test(r)), 'the rent was already recorded');
  const since = page.getByRole('table', { name: 'Entries posted since' });
  await since.getByText('Bank charges found late').waitFor();
  assert.equal(await since.locator('tbody tr').count(), 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ledger-replay.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
});
