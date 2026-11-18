/**
 * Browser end-to-end test for known devices (SEC-009): a person registers in one browser, signs
 * in from a second one and gets the new-device email, sees both devices on their account page,
 * trusts the one in use, and forgets the other, which signs it out. Real Next.js app → real API
 * → real MongoDB, with the API sending mail to a local SMTP server (port 4556), as in CI.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startSmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SMTP_PORT = Number(process.env.SMTP_STAND_IN_PORT ?? 4556);
const SHOTS = process.env.SHOTS_DIR;
const email = `e2e-devices-${randomUUID()}@example.test`;
const password = 'e2e-very-long-password';
let browser, smtp;
const consoleErrors = [];

before(async () => {
  smtp = await startSmtpStandIn(SMTP_PORT);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await smtp?.close();
});

const open = async (userAgent) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  return { ctx, page };
};

test('a sign-in from a new browser is emailed, and the person manages their devices', async () => {
  const laptop = await open('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36');
  await laptop.page.goto(`${WEB}/register`);
  await laptop.page.getByLabel('Full name').fill('Device Owner');
  await laptop.page.getByLabel('Email').fill(email);
  await laptop.page.getByLabel('Password').fill(password);
  await laptop.page.getByRole('button', { name: 'Create account' }).click();
  await laptop.page.waitForURL(/\/onboarding/);
  await laptop.page.getByLabel('Organisation name').fill('E2E Devices Co');
  await laptop.page.getByRole('button', { name: 'Create organisation' }).click();
  await laptop.page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = laptop.page.url().split('/').pop();
  // The device key is an httpOnly cookie only the sign-in endpoint receives.
  const key = (await laptop.ctx.cookies(`${WEB}/api/session`)).find((c) => c.name === 't2t_device');
  assert.ok(key?.httpOnly);
  assert.equal(key.path, '/api/session');
  assert.equal(smtp.messages.filter((m) => m.to?.includes(email)).length, 0);

  const phone = await open('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  await phone.page.goto(`${WEB}/login`);
  await phone.page.getByLabel('Email').fill(email);
  await phone.page.getByLabel('Password').fill(password);
  await phone.page.getByRole('button', { name: 'Sign in' }).click();
  await phone.page.waitForURL(/\/orgs\/[0-9a-f-]{36}/);
  for (let i = 0; i < 50 && !smtp.messages.some((m) => m.to?.includes(email)); i++) await new Promise((r) => setTimeout(r, 100));
  const alert = smtp.messages.find((m) => m.to?.includes(email));
  assert.equal(alert?.subject, 'New sign-in to your Talk2Tax account');
  assert.match(alert.text, /Device: Safari on iOS/);

  await phone.page.goto(`${WEB}/orgs/${orgId}/account`);
  const devices = phone.page.getByRole('table', { name: 'Your devices' });
  await devices.getByText('Safari on iOS').waitFor();
  await devices.getByText('Chrome on Windows').waitFor();
  await phone.page.getByRole('button', { name: 'Trust this device' }).click();
  await devices.getByText(/^Until /).waitFor();
  await phone.page.getByRole('heading', { name: 'Your devices' }).scrollIntoViewIfNeeded();
  if (SHOTS) await phone.page.screenshot({ path: `${SHOTS}/your-devices.png` });
  await phone.page.getByRole('button', { name: /^Forget Chrome on Windows/ }).click();
  await devices.getByText('Chrome on Windows').waitFor({ state: 'detached' });

  // The forgotten laptop is signed out on its next request.
  await laptop.page.goto(`${WEB}/orgs/${orgId}/account`);
  await laptop.page.waitForURL(/\/login/);
  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource|401/.test(e)), []);
});
