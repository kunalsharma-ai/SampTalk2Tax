/**
 * Browser end-to-end test for the month-end close: an owner starts the close of last month,
 * sees the checklist worked out from the books, makes tasks for open checks, has the AI review
 * the month, posts the rent accrual it proposes (with its reversal next month) and rejects
 * another entry, closes the month with a note, sees the certification, and reopens it.
 * Real Next.js app → real API → real PostgreSQL → the real Anthropic SDK against a local
 * stand-in for the Messages API (port 4555). The API must run with ANTHROPIC_API_KEY set and
 * ANTHROPIC_BASE_URL=http://127.0.0.1:4555. Nothing reaches Anthropic.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const STAND_IN_PORT = +(process.env.ANTHROPIC_STAND_IN_PORT ?? 4555);
let browser, page, standIn;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));

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
  standIn = await startAnthropicStandIn(STAND_IN_PORT);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await standIn?.close();
});

test('an owner closes last month with an AI-proposed accrual, then reopens it', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Close Owner');
  await page.getByLabel('Email').fill(`e2e-close-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Month End Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const M = shift(T.slice(0, 7), -1);
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!years.has(fyOf(shift(M, -3)))) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(shift(M, -3)) })).status, 201);
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const journal = (date, dr, cr, amount, memo) => call(`${base}/journals`, { date, memo, post: true, lines: [{ accountId: acc[dr], debit: amount }, { accountId: acc[cr], credit: amount }] });
  assert.equal((await journal(`${shift(M, -3)}-02`, '1120', '3100', '300000.00', 'Capital')).status, 201);
  for (const k of [-3, -2, -1]) assert.equal((await journal(`${shift(M, k)}-05`, '6200', '1120', '30000.00', 'Office rent')).status, 201);
  assert.equal((await journal(`${M}-12`, '1120', '4100', '90000.00', 'Sales')).status, 201);
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);
  const name = (await call(`${base}/close`)).body.periods.find((p) => p.startDate === `${M}-01`).name;

  standIn.script.push((body) => {
    const t = body.messages[0].content[0].text;
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_close_review' });
    assert.match(t, /Posted to in each of the 3 months before but nothing this month: 6200 Rent\./);
    return {
      content: [{
        type: 'tool_use', id: 'toolu_c1', name: 'submit_close_review',
        input: {
          summary: 'Sales of ₹90,000 are in, but rent, posted every month at ₹30,000, is missing.',
          findings: [{ title: 'Rent missing', detail: '6200 Rent was ₹30,000 in each of the three months before and nothing this month.' }],
          adjustments: [
            { description: 'Accrue rent for the month', reason: 'Rent of ₹30,000 was posted in each of the three months before.', confidence: 'HIGH', reverseNextPeriod: true, lines: [{ accountCode: '6200', debit: '30000.00' }, { accountCode: '2200', credit: '30000.00' }] },
            { description: 'Accrue a marketing retainer', reason: 'Agencies usually bill monthly.', confidence: 'LOW', reverseNextPeriod: true, lines: [{ accountCode: '6500', debit: '15000.00' }, { accountCode: '2200', credit: '15000.00' }] },
          ],
        },
      }],
      stop_reason: 'tool_use', inputTokens: 3100, outputTokens: 420,
    };
  });

  await page.getByRole('link', { name: 'Month-end close', exact: true }).click();
  await page.getByRole('heading', { name: 'Month-end close', exact: true }).waitFor();
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('heading', { name: `${name} close` }).waitFor();
  await page.getByRole('button', { name: 'Start close' }).click();
  await page.getByRole('button', { name: 'Create tasks for open checks' }).click();
  await page.getByText(/task(s)? created for accountants/).waitFor();
  await page.getByLabel('Earlier months are closed: open').waitFor();

  await page.getByRole('button', { name: 'Review with AI' }).click();
  const accrual = page.getByLabel('Accrue rent for the month: To review');
  await accrual.waitFor();
  await page.getByText('rent, posted every month at ₹30,000, is missing').waitFor();
  await accrual.getByText('Debits equal credits (₹30,000.00)').waitFor();
  await accrual.getByText(/Reversed on .*, the first day of/).waitFor();
  assert.equal((await call(`${base}/journals?status=POSTED`)).body.items?.filter?.((j) => j.source === 'CLOSE').length ?? 0, 0, 'nothing posted before review');

  await accrual.getByRole('button', { name: 'Post with reversal' }).click();
  await page.getByLabel('Accrue rent for the month: Posted').getByText(/Posted by Close Owner on .* · Journal #\d+, reversed by #\d+/).waitFor();
  const retainer = page.getByLabel('Accrue a marketing retainer: To review');
  await retainer.getByRole('button', { name: 'Reject…' }).click();
  await retainer.getByLabel('Why not? (optional)').fill('No retainer this year');
  await retainer.getByRole('button', { name: 'Reject entry' }).click();
  await page.getByLabel('Accrue a marketing retainer: Rejected').waitFor();

  const closeButton = page.getByRole('button', { name: `Close and lock ${name}` });
  assert.equal(await closeButton.isDisabled(), true, 'a note is needed with warnings open');
  await page.getByLabel(/Why closing with \d+ warnings? open is acceptable/).fill('Earlier months were before we started using the system.');
  await closeButton.click();
  const cert = page.getByLabel('Closed by Close Owner');
  await cert.waitFor();
  await cert.getByText('In force').waitFor();
  await cert.getByText('₹60,000.00').waitFor(); // net profit: 90,000 sales less 30,000 accrued rent
  const period = (await call(`${base}/periods`)).body.find((p) => p.startDate === `${M}-01`);
  assert.equal(period.status, 'LOCKED');

  await cert.getByRole('button', { name: 'Reopen…' }).click();
  await cert.getByLabel('Why reopen this month?').fill('A supplier invoice for the month arrived late');
  await cert.getByRole('button', { name: 'Reopen month' }).click();
  await cert.getByText(/Reopened by Close Owner on .*: A supplier invoice for the month arrived late/).waitFor();
  await page.getByRole('button', { name: `Close and lock ${name}` }).waitFor();

  await page.getByRole('link', { name: 'AI activity', exact: true }).click();
  await page.getByRole('heading', { name: 'AI activity', exact: true }).waitFor();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = page.getByRole('row', { name: new RegExp(`Reviewed the ${esc(name)} close: 2 adjusting entries proposed`) });
  await row.getByText('Entries: 1 posted, 1 rejected').waitFor();
  await row.getByText('3,100 / 420').waitFor();
  await row.getByRole('link').click();
  await page.getByRole('heading', { name: `${name} close` }).waitFor();

  assert.deepEqual(consoleErrors, []);
});
