/**
 * Browser end-to-end test for single sign-on (SEC-006/007): an owner connects an OpenID Connect
 * provider, proves the company's email domain with a DNS TXT record and lets new people join as
 * viewers; then someone at that domain signs in from the sign-in page through the provider and
 * lands in the organisation, and a cancelled sign-in comes back with the reason.
 * Real Next.js app → real API → real MongoDB → a local OpenID Connect provider and DNS server
 * (test-support/oidc-stand-in.mjs, ports 4558 and 4559). The API must run with
 * SSO_ALLOW_PRIVATE_NETWORKS=true and SSO_DNS_SERVERS=127.0.0.1:4559.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startOidcStandIn } from '../../../test-support/oidc-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
let browser;
let idp;
const consoleErrors = [];

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  return page;
}

before(async () => {
  browser = await chromium.launch();
  idp = await startOidcStandIn(4558, { dnsPort: 4559 });
});
after(async () => {
  await browser?.close();
  await idp?.close();
});

test('an owner sets up single sign-on and a colleague signs in with it', async () => {
  const domain = `t${randomUUID().slice(0, 8)}.example.test`;
  const owner = await newPage();
  await owner.goto(`${WEB}/register`);
  await owner.getByLabel('Full name').fill('SSO Owner');
  await owner.getByLabel('Email').fill(`owner@${domain}`);
  await owner.getByLabel('Password').fill('e2e-very-long-password');
  await owner.getByRole('button', { name: 'Create account' }).click();
  await owner.waitForURL(/\/onboarding|\/orgs/);
  await owner.getByLabel('Organisation name').fill('E2E SSO Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = owner.url();
  await owner.goto(`${orgUrl}/settings/sso`);

  assert.equal(await owner.getByTestId('redirect-uri').innerText(), `${WEB}/api/session/sso/callback`);
  const provider = owner.locator('form[aria-label="Identity provider"]');
  await provider.getByLabel('Issuer URL').fill(idp.issuer);
  await provider.getByLabel('Client ID').fill(idp.clientId);
  await provider.getByLabel('Client secret').fill(idp.clientSecret);
  await provider.getByRole('button', { name: 'Connect' }).click();
  await provider.getByText(`Saved (…${idp.clientSecret.slice(-4)})`).waitFor();

  const add = owner.locator('form[aria-label="Add a domain"]');
  await add.getByLabel('Domain').fill(domain);
  await add.getByRole('button', { name: 'Add domain' }).click();
  const row = owner.locator('table[aria-label="Sign-in domains"]').getByRole('row').filter({ hasText: domain });
  await row.getByText('Waiting for DNS').waitFor();
  const [name, value] = await row.locator('code').allInnerTexts();
  await row.getByRole('button', { name: 'Verify' }).click();
  await owner.getByRole('alert').filter({ hasText: 'No TXT record was found' }).waitFor();
  idp.txt.set(name, [value]);
  await row.getByRole('button', { name: 'Verify' }).click();
  await row.getByText('Verified').waitFor();

  await provider.getByLabel('New people at verified domains').selectOption('VIEWER');
  await provider.getByLabel(/Require it/).click();
  await provider.getByRole('button', { name: 'Save' }).click();
  await owner.getByText('Required', { exact: true }).waitFor();
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/single-sign-on.png` });

  // A colleague signs in through the provider and joins as a viewer.
  const colleague = await newPage();
  await colleague.goto(`${WEB}/login`);
  await colleague.getByRole('link', { name: 'Sign in with single sign-on' }).click();
  await colleague.waitForURL(/\/login\/sso/);
  await colleague.getByLabel('Work email').fill(`meera@${domain}`);
  if (SHOTS) await colleague.screenshot({ path: `${SHOTS}/single-sign-on-login.png` });
  await colleague.getByRole('button', { name: 'Continue' }).click();
  await colleague.waitForURL(/127\.0\.0\.1:4558\/authorize/);
  assert.equal(await colleague.getByLabel('Email').inputValue(), `meera@${domain}`);
  await colleague.getByRole('button', { name: 'Sign in' }).click();
  await colleague.waitForURL(orgUrl);
  await colleague.locator('option:checked', { hasText: 'E2E SSO Co' }).waitFor({ state: 'attached' });
  assert.equal(idp.tokens.at(-1).email, `meera@${domain}`);

  await owner.goto(`${orgUrl}/members`);
  await owner.getByRole('row').filter({ hasText: `meera@${domain}` }).filter({ hasText: /viewer/i }).waitFor();

  // Cancelling on the provider's page comes back with the reason.
  const other = await newPage();
  await other.goto(`${WEB}/login/sso?email=${encodeURIComponent(`ravi@${domain}`)}`);
  await other.getByRole('button', { name: 'Continue' }).click();
  await other.waitForURL(/127\.0\.0\.1:4558\/authorize/);
  await other.getByRole('button', { name: 'Cancel' }).click();
  await other.waitForURL(/\/login\/sso\?error=/);
  await other.getByRole('alert').filter({ hasText: 'The user cancelled the sign-in' }).waitFor();
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
