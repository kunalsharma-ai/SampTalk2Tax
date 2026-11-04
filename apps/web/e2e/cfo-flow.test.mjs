/**
 * Browser end-to-end test for the virtual CFO: an owner whose books show sales still owed and a
 * rent jump sees the health score and analyses, asks why profit changed and which invoices will
 * be late, prepares a board pack, writes commentary, has the AI write the summary (the scripted
 * Anthropic stand-in plays the model: one summary quotes a made-up figure and is rejected, the
 * next copies the figures and is kept), and finalises the pack. Nothing is posted.
 * Real Next.js app → real API → real PostgreSQL.
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
const call = (path, body, method = body ? 'POST' : 'GET') =>
  page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );

before(async () => {
  standIn = await startAnthropicStandIn(STAND_IN_PORT);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => {
  await browser?.close();
  await standIn?.close();
});

test('an owner reads the CFO assessment, asks questions and finalises a board pack with an AI summary', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Cora Cfo');
  await page.getByLabel('Email').fill(`e2e-cfo-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E CFO Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const L = shift(T.slice(0, 7), -1);
  const P = shift(L, -1);
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  for (const m of [P, L]) if (!years.has(fyOf(m))) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(m) })).status, 201), years.add(fyOf(m));
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const journal = (date, dr, cr, amount, memo) => call(`${base}/journals`, { date, memo, post: true, lines: [{ accountId: acc[dr], debit: amount }, { accountId: acc[cr], credit: amount }] });
  assert.equal((await journal(`${P}-15`, '1120', '3100', '500000.00', 'Capital')).status, 201);
  assert.equal((await journal(`${P}-15`, '6200', '1120', '20000.00', 'Rent')).status, 201);
  assert.equal((await journal(`${L}-15`, '6200', '1120', '50000.00', 'Rent and deposit')).status, 201);
  const acme = (await call(`${base}/contacts`, { name: 'Acme Retail', isCustomer: true })).body.id;
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: acme, issueDate: `${L}-01`, dueDate: `${L}-10`, post: true, lines: [{ accountId: acc['4100'], quantity: '1', unitPrice: '300000.00' }] })).status, 201);
  assert.equal((await call(`${base}/copilot/settings`, { enabled: true }, 'PUT')).status, 200);
  const journalsBefore = (await call(`${base}/journals?limit=100`)).body;
  const countBefore = (Array.isArray(journalsBefore) ? journalsBefore : journalsBefore.items).length;

  // The assessment.
  await page.getByRole('link', { name: 'Virtual CFO', exact: true }).click();
  await page.waitForURL(/\/cfo$/);
  const health = page.getByRole('region', { name: 'Financial health' }).or(page.getByLabel('Financial health'));
  await health.getByText(/out of 100/).waitFor();
  await page.getByLabel('How the score was worked out').getByText('Liquidity').waitFor();
  const liquidity = page.getByLabel('Liquidity', { exact: true });
  await liquidity.getByText('₹4,30,000.00', { exact: false }).first().waitFor();
  await liquidity.getByText('How this was worked out').click();
  await liquidity.getByText(/Current ratio = current assets/).waitFor();
  await page.getByLabel('Working capital', { exact: true }).getByText(/₹3,00,000\.00 of receivables is overdue/).waitFor();

  // Questions.
  await page.getByRole('group', { name: 'Questions' }).getByRole('button', { name: 'Why did profit change last month?' }).click();
  const answer = page.getByRole('region', { name: 'Answer' }).or(page.getByLabel('Answer', { exact: true }));
  await answer.getByText(/Net profit rose by ₹2,70,000\.00/).waitFor();
  await answer.getByRole('table').getByText('6200 Rent').waitFor();
  await answer.getByText('Method', { exact: true }).waitFor();
  assert.match(page.url(), /\?q=PROFIT_CHANGE$/);
  await page.getByRole('group', { name: 'Questions' }).getByRole('button', { name: 'Which invoices are likely to be paid late?' }).click();
  await answer.getByRole('table').getByText('Acme Retail').waitFor();
  await answer.getByText('Approval: A person reviews and sends each reminder').waitFor();

  // A board pack with commentary and an AI summary.
  await page.getByRole('button', { name: 'Prepare board pack' }).click();
  await page.waitForURL(/\/cfo\/reports\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: /^Board pack, / }).waitFor();
  await page.getByRole('textbox', { name: 'Commentary' }).fill('Sales picked up; the rent jump includes a one-off deposit.');
  await page.getByRole('button', { name: 'Save commentary' }).click();
  await page.getByRole('button', { name: 'Save commentary' }).and(page.locator(':disabled')).waitFor();

  standIn.script.push(() => ({ content: [{ type: 'text', text: 'Cash is ₹12,34,567 and everything is fine.' }] }));
  await page.getByRole('button', { name: 'Write with AI' }).click();
  await page.getByText(/The summary was not kept because it quoted figures that are not in the books: 1234567/).waitFor();
  const sent = standIn.requests.at(-1).body;
  assert.match(sent.system, /Every figure you write must appear in the facts/);
  assert.match(sent.messages[0].content[0].text, /₹4,30,000\.00/);

  standIn.script.push(() => ({ content: [{ type: 'text', text: 'Cash stood at ₹4,30,000.00. Revenue of ₹3,00,000.00 is still owed by Acme Retail, so collecting it is the first priority.' }] }));
  await page.getByRole('button', { name: 'Write with AI' }).click();
  const summary = page.getByLabel('Executive summary');
  await summary.getByText('collecting it is the first priority').waitFor();
  await summary.getByText(/every figure checked against the pack/).waitFor();

  await page.getByRole('button', { name: 'Finalise' }).click();
  await page.getByLabel('Pack status').getByText('Final', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Refresh figures' }).count(), 0);
  await page.getByText('Sales picked up; the rent jump includes a one-off deposit.').waitFor();

  // Listed on the CFO page; nothing posted.
  await page.getByRole('link', { name: 'Virtual CFO', exact: true }).first().click();
  await page.getByRole('table', { name: 'Packs' }).getByText('Final', { exact: true }).waitFor();
  const after = (await call(`${base}/journals?limit=100`)).body;
  assert.equal((Array.isArray(after) ? after : after.items).length, countBefore);
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
