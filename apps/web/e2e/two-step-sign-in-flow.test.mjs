/**
 * Browser end-to-end test for two-step sign-in: turning it on with an authenticator app (the
 * test computes the app's codes from the key on screen), saving recovery codes, signing in with
 * a code and with a recovery code, a wrong code, and turning it off. Real Next.js app → real
 * API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const email = `e2e-mfa-${randomUUID()}@example.test`;
const password = 'e2e-very-long-password';
let browser, page, ctx, orgId, secret, recoveryCodes;
let lastStep = -1;
const consoleErrors = [];
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);
/** The two-step sign-in card on the account page, scrolled into view. */
const cardShot = async (p, name) => {
  if (!SHOTS) return;
  await p.getByRole('heading', { name: 'Two-step sign-in' }).evaluate((h) => h.scrollIntoView({ block: 'start' }));
  await p.mouse.wheel(0, -90);
  await p.waitForTimeout(150);
  await shot(p, name);
};

/**
 * What an authenticator app shows (RFC 6238, SHA-1, 6 digits, 30 s), for a step not used yet.
 * Each step's code works once, and the next step's is accepted early (clock drift); beyond that,
 * wait for the clock as a person would.
 */
async function appCode() {
  while (lastStep + 1 > Math.floor(Date.now() / 30_000) + 1) await new Promise((r) => setTimeout(r, 500));
  const step = Math.max(Math.floor(Date.now() / 30_000), lastStep + 1);
  lastStep = step;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of secret.replace(/\s/g, '')) {
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

async function signIn() {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Leaves the app before clearing cookies: a page of the app still loading would see its
 * session go, redirect to the login page itself and abort the test's own navigation there.
 */
async function signedOut() {
  await page.goto('about:blank');
  await ctx.clearCookies();
}

/** Cookies the sign-in endpoint receives (the challenge cookie is limited to that path). */
const cookieNames = async () => (await ctx.cookies(`${WEB}/api/session`)).map((c) => c.name);

before(async () => {
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a new account turns on two-step sign-in', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Two Step Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Two Step Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();

  await page.goto(`${WEB}/orgs/${orgId}/account`);
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).waitFor();
  await cardShot(page, '01-account-two-step-off');
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await page.getByLabel('Your password').fill('not-my-password-at-all');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Current password is incorrect').waitFor();
  await page.getByLabel('Your password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByAltText('QR code for your authenticator app').waitFor();
  secret = (await page.getByTestId('mfa-secret').textContent()).replace(/\s/g, '');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  await cardShot(page, '02-scan-qr-code');

  await page.getByLabel('Code from the app').fill('000000');
  await page.getByRole('button', { name: 'Turn on', exact: true }).click();
  await page.getByText('That code is not right').waitFor();
  await page.getByLabel('Code from the app').fill(await appCode());
  await page.getByRole('button', { name: 'Turn on', exact: true }).click();
  await page.getByText('Save your recovery codes now').waitFor();
  recoveryCodes = await page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').allTextContents();
  assert.equal(recoveryCodes.length, 10);
  await cardShot(page, '03-recovery-codes');
  await page.getByRole('button', { name: 'I have saved them' }).click();
  await page.getByText('10 of 10 recovery codes left.').waitFor();
  await cardShot(page, '04-two-step-on');
});

test('signing in asks for the code after the password', async () => {
  await signedOut();
  await signIn();
  await page.getByRole('heading', { name: 'Two-step sign-in' }).waitFor();
  // The challenge is in an httpOnly cookie only the sign-in endpoint receives; no session yet.
  const names = await cookieNames();
  assert.ok(names.includes('t2t_mfa'));
  assert.ok(!names.includes('t2t_session'));
  await shot(page, '05-sign-in-code-step');
  await page.getByLabel('Code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByText('That code is not right').waitFor();
  await shot(page, '06-wrong-code');
  await page.getByLabel('Code').fill(await appCode());
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}/);
  const after = await cookieNames();
  assert.ok(after.includes('t2t_session'));
  assert.ok(!after.includes('t2t_mfa'));
});

test('a recovery code signs in once when the phone is lost', async () => {
  await signedOut();
  await signIn();
  await page.getByLabel('Code').fill(recoveryCodes[0].toLowerCase());
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}/);
  await page.goto(`${WEB}/orgs/${orgId}/account`);
  await page.getByText('9 of 10 recovery codes left.').waitFor();

  await signedOut();
  await signIn();
  await page.getByLabel('Code').fill(recoveryCodes[0]);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByText('That code is not right').waitFor();
  await page.getByLabel('Code').fill(await appCode());
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}/);
});

test('turning it off needs the password and a code', async () => {
  await page.goto(`${WEB}/orgs/${orgId}/account`);
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByLabel('Your password').fill(password);
  await page.getByLabel('Code from the app or a recovery code').fill(recoveryCodes[1]);
  await cardShot(page, '07-turn-off');
  await page.getByRole('button', { name: 'Turn off two-step sign-in' }).click();
  await page.getByText('Your password alone signs you in now.').waitFor();
  await signedOut();
  await signIn();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}/);
  const unexpected = consoleErrors.filter((e) => !/status of (401|422)/.test(e));
  assert.deepEqual(unexpected, []);
});
