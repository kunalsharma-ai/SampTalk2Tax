/**
 * Browser end-to-end test for sessions: silent renewal of an expired access cookie,
 * signing another device out, changing the password, sign-out ending the session in the
 * API, and the sign-in lockout message. Real Next.js app → real API → real PostgreSQL.
 * Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const email = `e2e-security-${randomUUID()}@example.test`;
const password = 'e2e-very-long-password';
const newPassword = 'e2e-another-long-password';
let browser, laptop, phone, laptopCtx, phoneCtx, orgId;
const consoleErrors = [];

function dropExpectedResourceErrors(fromIndex) {
  for (let i = consoleErrors.length - 1; i >= fromIndex; i--) {
    if (/Failed to load resource: the server responded with a status of (401|429)/.test(consoleErrors[i])) consoleErrors.splice(i, 1);
  }
}

async function signIn(page, pw = password, who = email) {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(who);
  await page.getByLabel('Password').fill(pw);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const cookie = async (ctx, name) => (await ctx.cookies(WEB)).find((c) => c.name === name)?.value;

before(async () => {
  browser = await chromium.launch();
  laptopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' });
  phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  laptop = await laptopCtx.newPage();
  phone = await phoneCtx.newPage();
  for (const p of [laptop, phone]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('one account signed in on two devices', async () => {
  await laptop.goto(`${WEB}/register`);
  await laptop.getByLabel('Full name').fill('Security Owner');
  await laptop.getByLabel('Email').fill(email);
  await laptop.getByLabel('Password').fill(password);
  await laptop.getByRole('button', { name: 'Create account' }).click();
  await laptop.waitForURL(/\/onboarding/);
  await laptop.getByLabel('Organisation name').fill('E2E Security Co');
  await laptop.getByRole('button', { name: 'Create organisation' }).click();
  await laptop.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = laptop.url().split('/').pop();
  await signIn(phone);
  await phone.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  assert.ok(await cookie(laptopCtx, 't2t_refresh'), 'refresh cookie is set');
});

test('an expired access cookie is renewed without signing in again', async () => {
  const before = await cookie(laptopCtx, 't2t_refresh');
  await laptopCtx.clearCookies({ name: 't2t_session' });
  await laptop.goto(`${WEB}/orgs/${orgId}/account`);
  await laptop.getByRole('heading', { name: 'Sign-in and security' }).waitFor();
  await laptop.getByText('Chrome on macOS').waitFor();
  assert.ok(await cookie(laptopCtx, 't2t_session'), 'a new access cookie was set');
  const after = await cookie(laptopCtx, 't2t_refresh');
  assert.ok(after && after !== before, 'the refresh token was rotated');
});

test('the laptop sees both devices and signs the phone out', async () => {
  const row = laptop.getByRole('row', { name: /Chrome on Android/ });
  await row.waitFor();
  await laptop.getByRole('row', { name: /This device/ }).getByText('Chrome on macOS').waitFor();
  await row.getByRole('button', { name: /^Sign out Chrome on Android/ }).click();
  await row.waitFor({ state: 'detached' });

  const mark = consoleErrors.length;
  await phone.goto(`${WEB}/orgs/${orgId}/journals`);
  await phone.waitForURL(/\/login/);
  dropExpectedResourceErrors(mark);
  assert.equal(await cookie(phoneCtx, 't2t_refresh'), undefined, 'the proxy cleared the dead session cookies');
});

test('changing the password signs out the other devices', async () => {
  await signIn(phone);
  await phone.waitForURL(/\/orgs\//);
  await laptop.reload();
  await laptop.getByRole('row', { name: /Chrome on Android/ }).waitFor();
  await laptop.getByLabel('Current password').fill(password);
  await laptop.getByLabel('New password', { exact: true }).fill(newPassword);
  await laptop.getByLabel('Confirm new password').fill(newPassword + 'x');
  await laptop.getByText('The passwords do not match').waitFor();
  assert.equal(await laptop.getByRole('button', { name: 'Change password' }).isDisabled(), true);
  await laptop.getByLabel('Confirm new password').fill(newPassword);
  await laptop.getByRole('button', { name: 'Change password' }).click();
  await laptop.getByText('1 other device was signed out.').waitFor();
  await laptop.getByRole('row', { name: /Chrome on Android/ }).waitFor({ state: 'detached' });

  const mark = consoleErrors.length;
  await phone.goto(`${WEB}/orgs/${orgId}/journals`);
  await phone.waitForURL(/\/login/);
  await signIn(phone, password);
  await phone.getByText('Email or password is incorrect').waitFor();
  dropExpectedResourceErrors(mark);
  await signIn(phone, newPassword);
  await phone.waitForURL(/\/orgs\//);
});

test('signing out ends the session in the API, not just the cookie', async () => {
  const stolen = await cookie(laptopCtx, 't2t_session');
  await laptop.getByRole('button', { name: 'Sign out' }).first().click();
  await laptop.waitForURL(/\/login/);
  const res = await fetch(`${process.env.T2T_API_URL ?? 'http://localhost:4000'}/v1/auth/me`, { headers: { authorization: `Bearer ${stolen}` } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'SESSION_REVOKED');
});

test('repeated wrong passwords lock the address for a while', async () => {
  const mark = consoleErrors.length;
  const target = `e2e-locked-${randomUUID()}@example.test`;
  for (let i = 0; i < 5; i++) {
    await signIn(laptop, `wrong-password-${i}-long`, target);
    await laptop.getByText('Email or password is incorrect').waitFor();
  }
  await signIn(laptop, 'wrong-password-again-long', target);
  await laptop.getByText(/Too many failed sign-ins for this email\. Try again in 15 minutes\./).waitFor();
  dropExpectedResourceErrors(mark);
});

test('no unexpected console errors were logged', () => {
  assert.deepEqual(consoleErrors.filter((e) => !/favicon/.test(e)), [], consoleErrors.join('\n'));
});
