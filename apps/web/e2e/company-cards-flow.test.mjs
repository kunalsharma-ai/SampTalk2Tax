/**
 * Browser end-to-end test for company cards (EXP-011/012): an owner sets up a card programme and
 * gets its token once, adds a corporate card by its last four digits and asks for a virtual card;
 * the card provider (through the app's /api/card-feed route) reads the controls, issues the
 * virtual card and sends spending; the owner explains a transaction, posts it to the books and
 * sees its journal, excludes another, and freezes a card, which the provider then sees. Real
 * Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, page;
let consoleErrors = [];
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
/** What the card provider sends, with the programme's token and no sign-in. */
const provider = (token, path, body) =>
  page.evaluate(
    async ([t, p, b]) => {
      const r = await fetch(`/api/card-feed/${p}`, { method: b ? 'POST' : 'GET', credentials: 'omit', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [token, path, body],
  );

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('an owner sets up company cards, the provider sends spending, and it is explained, posted and controlled', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Cora Cards');
  await page.getByLabel('Email').fill(`e2e-cards-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Card Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  consoleErrors = [];

  await page.goto(`${WEB}/orgs/${orgId}/expenses/cards`);
  await page.getByText('No card programmes yet').waitFor();
  const programmes = page.getByRole('region', { name: 'Card programmes' });
  await programmes.getByLabel('Programme name').fill('Corporate cards');
  await programmes.getByLabel('Card provider').fill('Synthetic Card Co');
  assert.equal(await programmes.getByLabel('Paid through').locator('option:checked').textContent(), '2150 Credit Card Payable');
  await programmes.getByRole('button', { name: 'Set up programme' }).click();
  const token = (await page.getByLabel('Card programme token').textContent()).trim();
  assert.match(token, /^t2tc_[A-Za-z0-9]{40}$/);

  const add = page.getByRole('region', { name: 'Add a company card' });
  await add.getByLabel('Cardholder').selectOption({ label: 'Cora Cards' });
  await add.getByLabel('Card name').fill('Travel card');
  await add.getByLabel('Monthly limit').fill('50000');
  await add.getByLabel('Last four digits').fill('4242');
  await add.getByRole('button', { name: 'Add card' }).click();
  await add.getByText('CARD-0001 Travel card is active').waitFor();
  await add.getByLabel('Kind of card').selectOption('VIRTUAL');
  await add.getByLabel('Cardholder').selectOption({ label: 'Cora Cards' });
  await add.getByLabel('Card name').fill('Software subscriptions');
  await add.getByLabel('Monthly limit').fill('5000');
  await add.getByRole('button', { name: 'Ask for the virtual card' }).click();
  await add.getByText('CARD-0002 Software subscriptions is waiting for the provider to issue it').waitFor();
  const cards = page.getByRole('table', { name: 'Company cards' });
  await cards.getByTestId('card-CARD-0002').getByText('Waiting for the provider').waitFor();

  // The provider reads the controls, issues the virtual card and sends spending.
  assert.equal((await provider('not-a-token', 'me')).status, 401);
  consoleErrors = []; // the refused token above logs its 401
  const controls = await provider(token, 'cards');
  assert.equal(controls.status, 200);
  const virtual = controls.body.cards.find((c) => c.reference === 'CARD-0002');
  assert.equal(virtual.status, 'REQUESTED');
  assert.equal((await provider(token, `cards/${virtual.id}/issued`, { providerRef: 'vc_1', last4: '7777', expires: '2030-06' })).status, 200);
  const sent = await provider(token, 'transactions', {
    transactions: [
      { id: 'tx-1', card: '4242', date: today(), amount: '1180.00', merchant: 'Synthetic Airways', mcc: '4511' },
      { id: 'tx-2', card: 'vc_1', date: today(), amount: '2999.00', merchant: 'Synthetic Cloud' },
      { id: 'tx-3', card: '4242', date: today(), amount: '45.00', merchant: 'Card test charge' },
      { id: 'tx-4', card: '0000', date: today(), amount: '10.00', merchant: 'No such card' },
    ],
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.added, 3);
  assert.equal(sent.body.rejected, 1);

  await page.reload();
  await page.getByTestId('cards-waiting').getByText('3 transactions are waiting to be explained and 0 are ready to post.').waitFor();
  await cards.getByTestId('card-CARD-0002').getByText('Active').waitFor();
  await cards.getByTestId('card-CARD-0001').getByText('2% used').waitFor();
  const spending = page.getByRole('table', { name: 'Card transactions' });
  const flight = spending.getByTestId('txn-tx-1');
  await flight.getByRole('button', { name: 'Explain' }).click();
  await flight.getByLabel('Account for Synthetic Airways').selectOption({ label: '6700 Travel' });
  await flight.getByLabel('Note for Synthetic Airways').fill('Flight to the Pune client');
  await flight.getByRole('button', { name: 'Save' }).click();
  await flight.getByText('Explained').waitFor();
  await flight.getByText('Flight to the Pune client').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/company-cards.png`, fullPage: true });
  await flight.getByRole('button', { name: 'Post' }).click();
  await flight.getByText('Posted').waitFor();
  await flight.getByRole('link', { name: /^Journal/ }).waitFor();

  const test = spending.getByTestId('txn-tx-3');
  await test.getByRole('button', { name: 'Exclude' }).click();
  await test.getByLabel('Why Card test charge stays out of the books').fill('Provider test charge, reversed');
  await test.getByRole('button', { name: 'Exclude' }).click();
  await test.getByText('Excluded: Provider test charge, reversed').waitFor();

  await cards.getByTestId('card-CARD-0002').getByRole('button', { name: 'Freeze' }).click();
  await cards.getByTestId('card-CARD-0002').getByText('Frozen').waitFor();
  const after = await provider(token, 'cards');
  assert.equal(after.body.cards.find((c) => c.reference === 'CARD-0002').status, 'FROZEN');

  // The journal debits travel and credits the card account.
  await flight.getByRole('link', { name: /^Journal/ }).click();
  await page.waitForURL(/\/journals\/[0-9a-f-]{36}$/);
  await page.getByText('Synthetic Airways · Flight to the Pune client').first().waitFor();
  assert.deepEqual(consoleErrors, []);
});
