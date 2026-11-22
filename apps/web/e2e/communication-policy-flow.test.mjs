/**
 * Browser end-to-end test for communication consent and policy (AR-043): on a customer's page
 * an accountant records that the customer opted out of email, with the reason, and sees the
 * record; the Communication policy page lists them; an owner stops automations emailing
 * contacts, and recording that they want email again takes them off the list.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
let browser, owner;
const consoleErrors = [];

async function call(page, path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };
async function register(page, name, email) {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
}

before(async () => {
  browser = await chromium.launch();
  owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  owner.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a customer who opts out is recorded, listed and not emailed', async () => {
  await register(owner, 'Ira Consent', `e2e-consent-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Consent Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const customer = await must(call(owner, `${B}/contacts`, { name: 'Synthetic Saffron Stores', isCustomer: true, email: 'accounts@saffron.example.test' }));

  // The customer's page: they receive email until an opt-out is recorded.
  await owner.goto(`${base}/sales/customers/${customer.id}`);
  const card = owner.getByRole('region', { name: 'Email consent' });
  await card.getByText('Receives email').waitFor();
  await card.getByText('No change recorded: they receive email.').waitFor();
  await card.getByLabel('Why they opted out').fill('Asked by phone to stop all reminders');
  await card.getByRole('button', { name: 'Stop emailing' }).click();
  await card.getByText('Synthetic Saffron Stores has opted out of email').waitFor();
  const history = card.getByRole('table', { name: 'Consent history' });
  await history.getByText('Asked by phone to stop all reminders').waitFor();
  assert.match(await history.innerText(), /Opted out[\s\S]*Ira Consent/);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/communication-consent-card.png` });

  // The policy page lists them, and the owner stops automations emailing contacts.
  await owner.goto(`${base}/settings/communication`);
  await owner.getByRole('heading', { name: 'Communication policy' }).waitFor();
  const list = owner.getByRole('table', { name: 'Opted out of email' });
  await list.getByRole('link', { name: 'Synthetic Saffron Stores' }).waitFor();
  assert.match(await list.innerText(), /accounts@saffron\.example\.test[\s\S]*Asked by phone to stop all reminders/);
  await owner.getByText('Not changed yet: automations may email contacts who have not opted out.').waitFor();
  const save = owner.getByRole('button', { name: 'Save policy' });
  assert.equal(await save.isDisabled(), true);
  await owner.getByLabel('Automations emailing customers and vendors').selectOption('BLOCKED');
  await save.click();
  await owner.getByText(/^Last changed by Ira Consent on /).waitFor();
  assert.equal((await must(call(owner, `${B}/communication-policy`))).policy.automationsToContacts, 'BLOCKED');
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/communication-policy.png`, fullPage: true });

  // They ask for email again: recorded on their page, and they leave the list.
  await list.getByRole('link', { name: 'Synthetic Saffron Stores' }).click();
  await owner.waitForURL(/\/sales\/customers\//);
  await card.getByLabel('Why they want email again').fill('Wrote back asking for statements');
  await card.getByRole('button', { name: 'Start emailing again' }).click();
  await card.getByText('Receives email').waitFor();
  assert.equal((await history.locator('tbody tr').count()), 2);
  await owner.goto(`${base}/settings/communication`);
  await owner.getByText('No one has opted out').waitFor();

  assert.deepEqual(consoleErrors, []);
});
