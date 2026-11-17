/**
 * Browser end-to-end test for an organisation that requires two-step sign-in: the owner turns
 * it on for themselves, requires it on Team and roles, and a member without it sees the set-up
 * card instead of the books until they turn it on. Real Next.js app → real API → real MongoDB.
 * Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.T2T_API_URL ?? 'http://localhost:4000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const password = 'e2e-very-long-password';
const owner = { email: `e2e-req-owner-${randomUUID()}@example.test`, lastStep: -1 };
const member = { email: `e2e-req-member-${randomUUID()}@example.test`, lastStep: -1 };
let browser, ownerPage, memberPage, orgId;
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);

/** What an authenticator app shows for this person's key, for a step they have not used yet. */
async function appCode(who) {
  while (who.lastStep + 1 > Math.floor(Date.now() / 30_000) + 1) await new Promise((r) => setTimeout(r, 500));
  const step = Math.max(Math.floor(Date.now() / 30_000), who.lastStep + 1);
  who.lastStep = step;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of who.secret) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = mac[19] & 15;
  return String((((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]) % 1_000_000).padStart(6, '0');
}

/** Turns two-step sign-in on through the card, wherever it is shown. */
async function turnOn(page, who) {
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await page.getByLabel('Your password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  who.secret = (await page.getByTestId('mfa-secret').textContent()).replace(/\s/g, '');
  await page.getByLabel('Code from the app').fill(await appCode(who));
  await page.getByRole('button', { name: 'Turn on', exact: true }).click();
  await page.getByText('Save your recovery codes now').waitFor();
}

before(async () => {
  browser = await chromium.launch();
  ownerPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  memberPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
});
after(async () => browser?.close());

test('the owner turns it on and requires it for everyone', async () => {
  const p = ownerPage;
  await p.goto(`${WEB}/register`);
  await p.getByLabel('Full name').fill('Required Owner');
  await p.getByLabel('Email').fill(owner.email);
  await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.waitForURL(/\/onboarding/);
  await p.getByLabel('Organisation name').fill('E2E Two Step Required Co');
  await p.getByRole('button', { name: 'Create organisation' }).click();
  await p.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = p.url().split('/').pop();

  // The member registers through the API; the owner adds them as a viewer.
  const reg = await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: member.email, name: 'Member Without', password }) });
  assert.equal(reg.status, 201);

  await p.goto(`${WEB}/orgs/${orgId}/members`);
  const require = p.getByRole('button', { name: 'Require two-step sign-in' });
  await require.waitFor();
  assert.ok(await require.isDisabled(), 'cannot require it before having it yourself');
  await p.getByText('Turn it on for yourself first, under Account.').waitFor();

  await p.goto(`${WEB}/orgs/${orgId}/account`);
  await turnOn(p, owner);
  await p.getByRole('button', { name: 'I have saved them' }).click();

  await p.goto(`${WEB}/orgs/${orgId}/members`);
  const add = await p.evaluate(async ([o, email]) => (await fetch(`/api/t2t/v1/orgs/${o}/members`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ email, role: 'VIEWER' }) })).status, [orgId, member.email]);
  assert.equal(add, 201);
  await p.reload();
  await p.getByRole('button', { name: 'Require two-step sign-in' }).click();
  await p.getByText('Required', { exact: true }).waitFor();
  await p.getByText('1 member does not have two-step sign-in on and cannot open the books until they turn it on.').waitFor();
  await p.getByRole('row', { name: /Member Without/ }).getByText('Off').waitFor();
  await shot(p, '08-members-two-step-required');
});

test('a member without it sees the set-up card instead of the books, then gets in', async () => {
  const p = memberPage;
  await p.goto(`${WEB}/login`);
  await p.getByLabel('Email').fill(member.email);
  await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL(/\/(orgs|onboarding)/);
  await p.goto(`${WEB}/orgs/${orgId}`);
  await p.getByRole('region', { name: 'Two-step sign-in required' }).waitFor();
  await p.getByText('E2E Two Step Required Co asks everyone who opens its books to use two-step sign-in.', { exact: false }).waitFor();
  await shot(p, '09-member-must-turn-it-on');
  await turnOn(p, member);
  await p.getByRole('button', { name: 'I have saved them' }).click();
  // The organisation opens as soon as it is on.
  await p.getByRole('region', { name: 'Two-step sign-in required' }).waitFor({ state: 'detached' });
  await p.getByRole('heading', { level: 1 }).first().waitFor();

  const r = await ownerPage.evaluate(async (o) => (await fetch(`/api/t2t/v1/orgs/${o}/security`)).json(), orgId);
  assert.equal(r.membersWithoutTwoStep, 0);
});
