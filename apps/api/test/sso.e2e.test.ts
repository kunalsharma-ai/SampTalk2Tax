import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOidcStandIn, type OidcStandIn } from '../../../test-support/oidc-stand-in.mjs';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Single sign-on with OpenID Connect (SEC-006/007) against the real API and database, and a local
 * OpenID Connect provider and DNS server (test-support/oidc-stand-in.mjs): an owner connects the
 * provider and proves a domain with a TXT record; members at that domain sign in through the
 * provider (code flow with PKCE, browser-bound state, signed ID token); tokens that are forged,
 * for other domains or unverified emails are refused; new people can join with a set role; and
 * when SSO is required, members (not owners) can no longer use a password.
 */
const OIDC_PORT = 4568;
const DNS_PORT = 4569;
let ctx: Ctx;
let idp: OidcStandIn;
let owner: TestUser;
let accountant: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let S: string;
const tag = randomUUID().slice(0, 8);
const DOMAIN = `t${tag}.example.test`;
const PASSWORD = 'a-very-long-test-password';

const register = async (email: string, name: string): Promise<TestUser> => {
  const res = await ctx.http().post('/v1/auth/register').send({ email, name, password: PASSWORD }).expect(201);
  return { id: res.body.user.id, email, token: res.body.accessToken, refreshToken: res.body.refreshToken, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
};
const binding = () => randomBytes(24).toString('base64url');

/** Starts a sign-in and comes back from the provider as `email`: what the browser would post to finish. */
async function signIn(startEmail: string, asEmail = startEmail) {
  const b = binding();
  const start = await ctx.http().post('/v1/auth/sso/start').send({ email: startEmail, binding: b }).expect(200);
  const back = new URL(await idp.approve(start.body.authorizationUrl, asEmail));
  return { binding: b, state: back.searchParams.get('state')!, code: back.searchParams.get('code')!, authorizationUrl: start.body.authorizationUrl as string, redirect: back };
}

beforeAll(async () => {
  idp = await startOidcStandIn(OIDC_PORT, { dnsPort: DNS_PORT });
  ctx = await bootApp({ SSO_ALLOW_PRIVATE_NETWORKS: 'true', SSO_DNS_SERVERS: `127.0.0.1:${DNS_PORT}`, APP_URL: 'http://localhost:3000' });
  owner = await register(`owner@${DOMAIN}`, 'SSO Owner');
  accountant = await register(`ana@${DOMAIN}`, 'Ana Accountant');
  outsider = await registerUser(ctx, 'SSO Outsider');
  org = await createOrg(ctx, owner, { name: 'SSO Traders Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other SSO Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  S = `${org.base}/sso`;
});
afterAll(async () => {
  await ctx?.app.close();
  await idp?.close();
});

describe('single sign-on', () => {
  it('lets an owner connect a provider and prove a domain by DNS', async () => {
    const empty = (await ctx.http().get(S).set(accountant.auth).expect(200)).body;
    expect(empty).toMatchObject({ canManage: false, connection: null, domains: [], redirectUri: 'http://localhost:3000/api/session/sso/callback' });
    await ctx.http().get(S).set(outsider.auth).expect(404);
    const body = { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, enabled: true, enforced: false, autoJoinRole: null };
    await ctx.http().put(S).set(accountant.auth).send(body).expect(403);

    const unreachable = await ctx.http().put(S).set(owner.auth).send({ ...body, issuer: 'http://127.0.0.1:9' }).expect(422);
    expect(unreachable.body.error).toBe('SSO_PROVIDER_UNREACHABLE');
    expect((await ctx.http().put(S).set(owner.auth).send({ ...body, clientSecret: undefined }).expect(422)).body.message).toMatch(/client secret/);
    expect((await ctx.http().put(S).set(owner.auth).send({ ...body, enforced: true }).expect(422)).body.message).toMatch(/Verify at least one domain/);
    const saved = (await ctx.http().put(S).set(owner.auth).send(body).expect(200)).body;
    expect(saved.connection).toMatchObject({ issuer: idp.issuer, clientId: idp.clientId, clientSecretHint: `…${idp.clientSecret.slice(-4)}`, enabled: true, enforced: false, autoJoinRole: null });
    expect(JSON.stringify(saved)).not.toContain(idp.clientSecret);

    expect((await ctx.http().post(`${S}/domains`).set(owner.auth).send({ domain: 'not a domain' }).expect(422)).body.error).toBe('SSO_INVALID');
    const added = (await ctx.http().post(`${S}/domains`).set(owner.auth).send({ domain: DOMAIN.toUpperCase() }).expect(201)).body.domains[0];
    expect(added).toMatchObject({ domain: DOMAIN, verifiedAt: null, record: { name: `_talk2tax-verification.${DOMAIN}` } });
    // Not verified until the TXT record holds the value.
    expect((await ctx.http().post(`${S}/domains/${added.id}/verify`).set(owner.auth).expect(422)).body.message).toMatch(/No TXT record was found/);
    idp.txt.set(added.record.name, ['v=spf1 -all']);
    expect((await ctx.http().post(`${S}/domains/${added.id}/verify`).set(owner.auth).expect(422)).body.message).toMatch(/not the value shown here/);
    idp.txt.set(added.record.name, ['v=spf1 -all', added.record.value]);
    const verified = (await ctx.http().post(`${S}/domains/${added.id}/verify`).set(owner.auth).expect(200)).body.domains[0];
    expect(verified.verifiedAt).not.toBeNull();

    // Another organisation cannot take the domain, even with its own TXT value published.
    const theirs = (await ctx.http().post(`${other.base}/sso/domains`).set(outsider.auth).send({ domain: DOMAIN }).expect(201)).body.domains[0];
    idp.txt.set(theirs.record.name, [added.record.value, theirs.record.value]);
    expect((await ctx.http().post(`${other.base}/sso/domains/${theirs.id}/verify`).set(outsider.auth).expect(409)).body.error).toBe('SSO_DOMAIN_TAKEN');

    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'sso.' } } });
    expect(audit.map((a) => a.action).sort()).toEqual(['sso.connection_saved', 'sso.domain_added', 'sso.domain_verified']);
  });

  it('signs a member in through the provider, once, in the browser that started', async () => {
    expect((await ctx.http().post('/v1/auth/sso/start').send({ email: `x@nowhere-${tag}.example.test`, binding: binding() }).expect(404)).body.error).toBe('SSO_NOT_SET_UP');
    const s = await signIn(accountant.email);
    const auth = new URL(s.authorizationUrl).searchParams;
    expect(auth.get('code_challenge_method')).toBe('S256');
    expect(auth.get('redirect_uri')).toBe('http://localhost:3000/api/session/sso/callback');
    expect(auth.get('login_hint')).toBe(accountant.email);

    // Another browser (another binding) cannot finish it.
    expect((await ctx.http().post('/v1/auth/sso/finish').send({ state: s.state, code: s.code, binding: binding() }).expect(401)).body.error).toBe('SSO_STATE_INVALID');
    const ok = (await ctx.http().post('/v1/auth/sso/finish').set('user-agent', 'SSO test').send({ state: s.state, code: s.code, binding: s.binding }).expect(200)).body;
    expect(ok).toMatchObject({ orgId: org.orgId, user: { id: accountant.id, email: accountant.email } });
    const me = (await ctx.http().get('/v1/auth/me').set({ Authorization: `Bearer ${ok.accessToken}` }).expect(200)).body;
    expect(me.id ?? me.user?.id).toBe(accountant.id);
    // The provider checked the client secret and the PKCE verifier.
    expect(idp.requests.some((r) => r.path === '/token' && /^Basic /.test(String(r.headers.authorization)))).toBe(true);
    // Used once.
    await ctx.http().post('/v1/auth/sso/finish').send({ state: s.state, code: s.code, binding: s.binding }).expect(401);
    const signedIn = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'sso.signed_in', actorId: accountant.id } });
    expect(signedIn?.data).toMatchObject({ issuer: idp.issuer, joined: false });
  });

  it('refuses forged tokens, other domains, unverified emails, non-members and cancelled sign-ins', async () => {
    const finish = async (s: Awaited<ReturnType<typeof signIn>>) => (await ctx.http().post('/v1/auth/sso/finish').send({ state: s.state, code: s.code, binding: s.binding }).expect(403)).body;

    idp.next = { wrongKey: true };
    expect(await finish(await signIn(accountant.email))).toMatchObject({ error: 'SSO_TOKEN_INVALID', message: expect.stringMatching(/signature/) });
    idp.next = { nonce: 'replayed' };
    expect((await finish(await signIn(accountant.email))).error).toBe('SSO_TOKEN_INVALID');
    // The provider is the organisation's, but it cannot sign in someone at another domain.
    expect((await finish(await signIn(accountant.email, outsider.email))).error).toBe('SSO_DOMAIN_MISMATCH');
    idp.next = { emailVerified: false };
    expect((await finish(await signIn(accountant.email))).error).toBe('SSO_EMAIL_NOT_VERIFIED');
    expect((await finish(await signIn(`newcomer@${DOMAIN}`))).error).toBe('SSO_NOT_A_MEMBER');
    expect(await ctx.prisma.user.findUnique({ where: { email: `newcomer@${DOMAIN}` } })).toBeNull();

    const b = binding();
    const start = (await ctx.http().post('/v1/auth/sso/start').send({ email: accountant.email, binding: b }).expect(200)).body;
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const cancelled = (await ctx.http().post('/v1/auth/sso/finish').send({ state, binding: b, error: 'access_denied', errorDescription: 'The user cancelled the sign-in' }).expect(403)).body;
    expect(cancelled).toMatchObject({ error: 'SSO_PROVIDER_REFUSED', message: expect.stringMatching(/cancelled/) });

    const refusals = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'sso.sign_in_refused' } });
    expect(refusals.map((r) => (r.data as { reason: string }).reason).sort()).toEqual(['domain', 'email_not_verified', 'not_member', 'provider:access_denied', 'token', 'token']);
  });

  it('lets new people at the domain join with the chosen role', async () => {
    const body = { issuer: idp.issuer, clientId: idp.clientId, enabled: true, enforced: false, autoJoinRole: 'VIEWER' };
    expect((await ctx.http().put(S).set(owner.auth).send({ ...body, autoJoinRole: 'ADMIN' }).expect(400)).body.error).toBe('VALIDATION_FAILED');
    await ctx.http().put(S).set(owner.auth).send(body).expect(200);
    const email = `ravi.kumar@${DOMAIN}`;
    const s = await signIn(email);
    const ok = (await ctx.http().post('/v1/auth/sso/finish').send({ state: s.state, code: s.code, binding: s.binding }).expect(200)).body;
    expect(ok.user).toMatchObject({ email, name: 'ravi kumar' });
    const members = (await ctx.http().get(`${org.base}/members`).set(owner.auth).expect(200)).body as { email?: string; user?: { email: string }; role: string }[];
    expect(members.find((m) => (m.email ?? m.user?.email) === email)?.role).toBe('VIEWER');
    const joined = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'sso.member_joined', actorId: ok.user.id } });
    expect(joined?.data).toMatchObject({ role: 'VIEWER', newAccount: true });
  });

  it('when required, refuses members a password but not owners, and keeps the client secret sealed', async () => {
    const body = { issuer: idp.issuer, clientId: idp.clientId, enabled: true, enforced: true, autoJoinRole: null };
    await ctx.http().put(S).set(owner.auth).send(body).expect(200);
    const refused = await ctx.http().post('/v1/auth/login').send({ email: accountant.email, password: PASSWORD }).expect(403);
    expect(refused.body.error).toBe('SSO_REQUIRED');
    // A wrong password is still just a wrong password.
    expect((await ctx.http().post('/v1/auth/login').send({ email: accountant.email, password: 'wrong-password-123456' }).expect(401)).body.error).toBe('INVALID_CREDENTIALS');
    await ctx.http().post('/v1/auth/login').send({ email: owner.email, password: PASSWORD }).expect(200);
    // The last verified domain stays while SSO is required.
    const d = (await ctx.http().get(S).set(owner.auth).expect(200)).body.domains[0];
    expect((await ctx.http().delete(`${S}/domains/${d.id}`).set(owner.auth).expect(422)).body.message).toMatch(/stop requiring it first/);

    const stored = await ctx.prisma.ssoConnection.findUnique({ where: { orgId: org.orgId } });
    expect(stored?.clientSecretCipher).not.toContain(idp.clientSecret);

    // Turning SSO off gives members their password back.
    await ctx.http().put(S).set(owner.auth).send({ ...body, enabled: false, enforced: false }).expect(200);
    await ctx.http().post('/v1/auth/login').send({ email: accountant.email, password: PASSWORD }).expect(200);
    expect((await ctx.http().post('/v1/auth/sso/start').send({ email: accountant.email, binding: binding() }).expect(404)).body.error).toBe('SSO_NOT_SET_UP');
    await ctx.http().delete(S).set(owner.auth).expect(200);
    expect((await ctx.http().get(S).set(owner.auth).expect(200)).body.connection).toBeNull();
  });
});
