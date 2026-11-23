/**
 * Browser end-to-end test for bank feeds (BANK-004): an owner sets up a feed for a bank account
 * and copies its token; a sender posts transactions to the app's own address; the feed shows as
 * healthy with the lines added, the delivery lists the refused transaction and why, the lines
 * wait on the account to be matched, and pausing the feed makes the sender's next delivery fail.
 * Real Next.js app, API and MongoDB.
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
const send = async (token, transactions) => {
  const r = await fetch(`${WEB}/api/bank-feed/transactions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ transactions }) });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a bank feed is set up, receives transactions and is paused', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Farah Feeds');
  await page.getByLabel('Email').fill(`e2e-bank-feeds-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Feeding Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  consoleErrors.length = 0;

  await page.goto(`${base}/banking/feeds`);
  await page.getByText('No bank feeds yet').waitFor();
  const setup = page.getByRole('region', { name: 'Set up a feed' });
  const option = await setup.getByLabel('Bank account').locator('option').filter({ hasText: /^1120 / }).first().textContent();
  await setup.getByLabel('Bank account').selectOption({ label: option });
  await setup.getByLabel('Feed name').fill('HDFC host-to-host');
  await setup.getByLabel('Expect something').selectOption({ label: 'every 6 hours' });
  await setup.getByRole('button', { name: 'Set up feed' }).click();
  const token = (await page.getByLabel('Feed token').textContent()).trim();
  assert.match(token, /^t2tf_[A-Za-z0-9]{40}$/);
  await page.getByText('/api/bank-feed/transactions').first().waitFor();
  const feeds = page.getByRole('region', { name: 'Bank feeds set up' });
  await feeds.getByRole('cell', { name: /Waiting/ }).waitFor();

  // The sender, with only the token, on the app's own address.
  assert.equal((await fetch(`${WEB}/api/bank-feed/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  const d = await send(token, [
    { id: 'UTR-501', date: day(-2), amount: '48000.00', description: 'NEFT Harbour Cafe', reference: 'UTR-501' },
    { id: 'UTR-502', date: day(-1), amount: '1250.00', direction: 'DEBIT', description: 'Power bill' },
    { id: 'UTR-503', date: day(-1), amount: 99, description: 'Card fee' },
  ]);
  assert.equal(d.status, 200);
  assert.deepEqual([d.body.outcome, d.body.imported, d.body.rejected], ['IMPORTED', 2, 1]);
  assert.equal((await send(token, [{ id: 'UTR-501', date: day(-2), amount: '48000.00', description: 'NEFT Harbour Cafe' }])).body.outcome, 'NOTHING_NEW');

  await page.reload();
  await feeds.getByRole('cell', { name: /Healthy/ }).waitFor();
  await feeds.getByRole('link', { name: 'HDFC host-to-host' }).click();
  await page.waitForURL(/\/banking\/feeds\/[0-9a-f-]{36}$/);
  const deliveries = page.getByRole('region', { name: 'Feed deliveries' });
  await deliveries.getByText('Nothing new', { exact: true }).waitFor();
  await deliveries.getByText('UTR-503 (line 3)').waitFor();
  await deliveries.getByText(/amount sent as a number/).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bank-feed.png`, fullPage: true });

  await page.getByRole('button', { name: 'Pause feed' }).click();
  await page.getByRole('button', { name: 'Resume feed' }).waitFor();
  const paused = await send(token, [{ id: 'UTR-504', date: day(-1), amount: '10.00', description: 'Interest' }]);
  assert.deepEqual([paused.status, paused.body.error], [409, 'FEED_PAUSED']);

  // The fed lines wait on the account to be matched.
  await page.getByRole('link', { name: 'Reconcile them' }).click();
  await page.getByText('NEFT Harbour Cafe').first().waitFor();
  await page.getByText('Power bill').first().waitFor();
  assert.deepEqual(consoleErrors, []);
});
