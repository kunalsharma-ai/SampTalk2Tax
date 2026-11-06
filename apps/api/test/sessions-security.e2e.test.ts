import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowCounter } from '../src/auth/rate-limit';
import { bootApp, Ctx, registerUser, TestUser } from './helpers';

const PASSWORD = 'a-very-long-test-password';
let ctx: Ctx;
beforeAll(async () => {
  ctx = await bootApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
function login(c: Ctx, email: string, password = PASSWORD, headers: Record<string, string> = {}) {
  return c.http().post('/v1/auth/login').set(headers).send({ email, password });
}

describe('refresh tokens', () => {
  it('rotates on every refresh and keeps the session', async () => {
    const u = await registerUser(ctx);
    expect(u.refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const r1 = await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
    expect(r1.body.refreshToken).toBeTruthy();
    expect(r1.body.refreshToken).not.toBe(u.refreshToken);
    expect(r1.body.sessionId).toBe(u.refreshToken.split('.')[0]);
    expect(r1.body.expiresIn).toBe(Number(process.env.JWT_TTL_SECONDS ?? 900));
    await ctx.http().get('/v1/auth/me').set(bearer(r1.body.accessToken)).expect(200);
    const r2 = await ctx.http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(200);
    await ctx.http().get('/v1/auth/me').set(bearer(r2.body.accessToken)).expect(200);
    const row = await ctx.prisma.authSession.findUniqueOrThrow({ where: { id: r1.body.sessionId } });
    expect(row.rotationCount).toBe(2);
    // Only a hash of the secret is stored.
    expect(row.secretHash).not.toContain(r2.body.refreshToken.split('.')[1]);
  });

  it('accepts the replaced token for a few seconds (racing tabs) without rotating again', async () => {
    const u = await registerUser(ctx);
    const r1 = await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
    const late = await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
    expect(late.body.refreshToken).toBeNull();
    await ctx.http().get('/v1/auth/me').set(bearer(late.body.accessToken)).expect(200);
    // The rotated token is still the live one.
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(200);
  });

  it('treats an old token used after the grace window as theft and ends the session', async () => {
    const u = await registerUser(ctx);
    const r1 = await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
    await ctx.prisma.authSession.update({ where: { id: r1.body.sessionId }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
    const reuse = await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401);
    expect(reuse.body.error).toBe('REFRESH_TOKEN_REUSED');
    // Both the thief's and the owner's tokens are now dead.
    expect((await ctx.http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401)).body.error).toBe('SESSION_REVOKED');
    expect((await ctx.http().get('/v1/auth/me').set(bearer(r1.body.accessToken)).expect(401)).body.error).toBe('SESSION_REVOKED');
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { action: 'session.refresh_reuse_detected', entityId: r1.body.sessionId } });
    expect(audit).toBeTruthy();
  });

  it('refuses malformed, unknown and wrong-secret tokens without ending the session', async () => {
    const u = await registerUser(ctx);
    const sid = u.refreshToken.split('.')[0];
    for (const refreshToken of ['nope', `${randomUUID()}.${'a'.repeat(43)}`, `${sid}.${'b'.repeat(43)}`]) {
      expect((await ctx.http().post('/v1/auth/refresh').send({ refreshToken }).expect(401)).body.error).toBe('INVALID_REFRESH_TOKEN');
    }
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
  });

  it('ends sessions past their hard expiry or idle limit', async () => {
    const a = await registerUser(ctx);
    const sidA = a.refreshToken.split('.')[0];
    await ctx.prisma.$executeRaw`UPDATE auth_sessions SET expires_at = created_at + interval '1 millisecond' WHERE id = ${sidA}::uuid`;
    expect((await ctx.http().get('/v1/auth/me').set(a.auth).expect(401)).body.error).toBe('SESSION_EXPIRED');
    expect((await ctx.http().post('/v1/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401)).body.error).toBe('SESSION_EXPIRED');

    const b = await registerUser(ctx);
    const sidB = b.refreshToken.split('.')[0];
    await ctx.prisma.authSession.update({ where: { id: sidB }, data: { lastUsedAt: new Date(Date.now() - 8 * 86_400_000) } });
    expect((await ctx.http().post('/v1/auth/refresh').send({ refreshToken: b.refreshToken }).expect(401)).body.error).toBe('SESSION_EXPIRED');
    expect((await ctx.prisma.authSession.findUniqueOrThrow({ where: { id: sidB } })).revokedReason).toBe('expired');
  });

  it('rejects access tokens that do not name a session, and expired ones with TOKEN_EXPIRED', async () => {
    const u = await registerUser(ctx);
    const key = new TextEncoder().encode(process.env.JWT_SECRET ?? 'test-secret-that-is-long-enough-for-hs256-signing');
    const base = () => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer('talk2tax-api').setAudience('talk2tax').setIssuedAt();
    const noSid = await base().setExpirationTime('5m').sign(key);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(noSid)).expect(401)).body.error).toBe('TOKEN_EXPIRED');
    const expired = await new SignJWT({ sid: u.refreshToken.split('.')[0] }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer('talk2tax-api').setAudience('talk2tax').setIssuedAt(Math.floor(Date.now() / 1000) - 120).setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(key);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(expired)).expect(401)).body.error).toBe('TOKEN_EXPIRED');
    // A session id belonging to someone else does not work with your user id.
    const other = await registerUser(ctx);
    const swapped = await base().setExpirationTime('5m').sign(key).then(() => new SignJWT({ sid: other.refreshToken.split('.')[0] }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer('talk2tax-api').setAudience('talk2tax').setIssuedAt().setExpirationTime('5m').sign(key));
    await ctx.http().get('/v1/auth/me').set(bearer(swapped)).expect(401);
  });
});

describe('sessions and sign-out', () => {
  it('lists sessions, marks the current one, and revokes one or all others', async () => {
    const u = await registerUser(ctx);
    const phone = (await login(ctx, u.email, PASSWORD, { 'user-agent': 'SyntheticPhone/1.0' }).expect(200)).body;
    const laptop = (await login(ctx, u.email, PASSWORD, { 'user-agent': 'SyntheticLaptop/2.0' }).expect(200)).body;
    const list = (await ctx.http().get('/v1/auth/sessions').set(bearer(laptop.accessToken)).expect(200)).body as { id: string; current: boolean; userAgent: string }[];
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current).map((s) => s.userAgent)).toEqual(['SyntheticLaptop/2.0']);
    expect(JSON.stringify(list)).not.toMatch(/secret/i);

    await ctx.http().delete(`/v1/auth/sessions/${phone.sessionId}`).set(bearer(laptop.accessToken)).expect(204);
    expect((await ctx.http().get('/v1/auth/me').set(bearer(phone.accessToken)).expect(401)).body.error).toBe('SESSION_REVOKED');
    expect((await ctx.http().post('/v1/auth/refresh').send({ refreshToken: phone.refreshToken }).expect(401)).body.error).toBe('SESSION_REVOKED');

    const res = await ctx.http().post('/v1/auth/sessions/revoke-others').set(bearer(laptop.accessToken)).expect(200);
    expect(res.body.signedOut).toBe(1);
    await ctx.http().get('/v1/auth/me').set(u.auth).expect(401);
    const after = (await ctx.http().get('/v1/auth/sessions').set(bearer(laptop.accessToken)).expect(200)).body;
    expect(after).toHaveLength(1);
  });

  it("cannot see or end another user's sessions", async () => {
    const a = await registerUser(ctx);
    const b = await registerUser(ctx);
    await ctx.http().delete(`/v1/auth/sessions/${b.refreshToken.split('.')[0]}`).set(a.auth).expect(404);
    await ctx.http().get('/v1/auth/me').set(b.auth).expect(200);
    const list = (await ctx.http().get('/v1/auth/sessions').set(a.auth).expect(200)).body;
    expect(list).toHaveLength(1);
  });

  it('signs out the current session with the access token or with the refresh token', async () => {
    const a = await registerUser(ctx);
    await ctx.http().delete('/v1/auth/sessions/current').set(a.auth).expect(204);
    await ctx.http().get('/v1/auth/me').set(a.auth).expect(401);

    const b = await registerUser(ctx);
    await ctx.http().post('/v1/auth/logout').send({ refreshToken: b.refreshToken }).expect(204);
    await ctx.http().get('/v1/auth/me').set(b.auth).expect(401);
    // Unknown tokens get the same answer, and nothing happens.
    await ctx.http().post('/v1/auth/logout').send({ refreshToken: 'garbage' }).expect(204);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { action: 'session.revoked', entityId: b.refreshToken.split('.')[0] } });
    expect((audit?.data as { reason: string }).reason).toBe('signed_out');
  });

  it('the database refuses to revive a revoked session or move it to another user', async () => {
    const a = await registerUser(ctx);
    const b = await registerUser(ctx);
    const sid = a.refreshToken.split('.')[0];
    await ctx.http().delete('/v1/auth/sessions/current').set(a.auth).expect(204);
    await expect(ctx.prisma.$executeRaw`UPDATE auth_sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = ${sid}::uuid`).rejects.toThrow(/revoked session/);
    const live = b.refreshToken.split('.')[0];
    await expect(ctx.prisma.$executeRaw`UPDATE auth_sessions SET user_id = ${a.id}::uuid WHERE id = ${live}::uuid`).rejects.toThrow(/cannot change its user/);
    await expect(ctx.prisma.$executeRaw`UPDATE auth_sessions SET expires_at = expires_at + interval '1 day' WHERE id = ${live}::uuid`).rejects.toThrow(/hard expiry/);
  });
});

describe('password change', () => {
  it('needs the current password, then signs out every other session', async () => {
    const u = await registerUser(ctx);
    const other = (await login(ctx, u.email).expect(200)).body;
    const wrong = await ctx.http().put('/v1/auth/password').set(u.auth).send({ currentPassword: 'not-the-password-1', newPassword: 'another-very-long-password' }).expect(422);
    expect(wrong.body.error).toBe('WRONG_PASSWORD');
    expect((await ctx.http().put('/v1/auth/password').set(u.auth).send({ currentPassword: PASSWORD, newPassword: 'short' }).expect(422)).body.error).toBe('WEAK_PASSWORD');
    expect((await ctx.http().put('/v1/auth/password').set(u.auth).send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(422)).body.error).toBe('SAME_PASSWORD');
    const ok = await ctx.http().put('/v1/auth/password').set(u.auth).send({ currentPassword: PASSWORD, newPassword: 'another-very-long-password' }).expect(200);
    expect(ok.body.otherSessionsSignedOut).toBe(1);
    await ctx.http().get('/v1/auth/me').set(u.auth).expect(200);
    await ctx.http().get('/v1/auth/me').set(bearer(other.accessToken)).expect(401);
    await login(ctx, u.email).expect(401);
    await login(ctx, u.email, 'another-very-long-password').expect(200);
  });
});

describe('sign-in lockout', () => {
  async function expectLockout(email: string, correctPassword: string | null) {
    for (let i = 0; i < 5; i++) expect((await login(ctx, email, `wrong-password-${i}-xx`).expect(401)).body.error).toBe('INVALID_CREDENTIALS');
    const locked = await login(ctx, email, 'wrong-password-again').expect(429);
    expect(locked.body.error).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    if (correctPassword) expect((await login(ctx, email, correctPassword).expect(429)).body.error).toBe('TOO_MANY_ATTEMPTS');
    // Each response has its own request id; the rest must not tell the two cases apart.
    const { requestId: _id, ...body } = locked.body;
    return body;
  }

  it('locks an address after five failures, even for the right password, then lets it in after the lock', async () => {
    const u = await registerUser(ctx);
    await expectLockout(u.email, PASSWORD);
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'user.sign_in_locked', entityId: u.id } })).toBeTruthy();
    await ctx.prisma.loginThrottle.update({ where: { email: u.email }, data: { lockedUntil: new Date(Date.now() - 1000), firstFailureAt: new Date(Date.now() - 20 * 60_000) } });
    await login(ctx, u.email).expect(200);
    expect(await ctx.prisma.loginThrottle.findUnique({ where: { email: u.email } })).toBeNull();
  });

  it('answers the same way for an address with no account', async () => {
    const real = await registerUser(ctx);
    const a = await expectLockout(real.email, PASSWORD);
    const b = await expectLockout(`ghost-${randomUUID()}@example.test`, null);
    expect(b).toEqual(a);
  });

  it('a successful sign-in clears earlier failures', async () => {
    const u = await registerUser(ctx);
    for (let i = 0; i < 4; i++) await login(ctx, u.email, 'wrong-password-zz').expect(401);
    await login(ctx, u.email).expect(200);
    for (let i = 0; i < 4; i++) await login(ctx, u.email, 'wrong-password-zz').expect(401);
    await login(ctx, u.email).expect(200);
  });
});

describe('rate limiting', () => {
  let limited: Ctx;
  let user: TestUser;
  beforeAll(async () => {
    limited = await bootApp({ RATE_LIMIT_AUTH_PER_MINUTE: '4', RATE_LIMIT_API_PER_MINUTE: '6', TRUST_PROXY_HOPS: '1' });
  });
  afterAll(async () => {
    await limited.app.close();
  });

  it('limits sign-in, register and refresh per client IP', async () => {
    const ip = { 'x-forwarded-for': '198.51.100.7' };
    const email = `rl-${randomUUID()}@example.test`;
    const reg = await limited.http().post('/v1/auth/register').set(ip).send({ email, name: 'RL', password: PASSWORD }).expect(201);
    expect(reg.headers['ratelimit-limit']).toBe('4');
    user = { id: reg.body.user.id, email, token: reg.body.accessToken, refreshToken: reg.body.refreshToken, auth: bearer(reg.body.accessToken) };
    await login(limited, email, PASSWORD, ip).expect(200);
    await login(limited, email, PASSWORD, ip).expect(200);
    await limited.http().post('/v1/auth/refresh').set(ip).send({ refreshToken: reg.body.refreshToken }).expect(200);
    const blocked = await login(limited, email, PASSWORD, ip).expect(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Another client address has its own budget.
    await login(limited, email, PASSWORD, { 'x-forwarded-for': '198.51.100.8' }).expect(200);
    // The session list shows the address the trusted proxy reported.
    const sessions = (await limited.http().get('/v1/auth/sessions').set(user.auth).set(ip).expect(200)).body as { ipAddress: string }[];
    expect(sessions.map((s) => s.ipAddress)).toContain('198.51.100.7');
  });

  it('limits other API calls per signed-in user', async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await limited.http().get('/v1/orgs').set(user.auth)).status;
    expect(last).toBe(429);
    // A different user (same address) is not affected.
    const email = `rl2-${randomUUID()}@example.test`;
    const reg = await limited.http().post('/v1/auth/register').set({ 'x-forwarded-for': '198.51.100.9' }).send({ email, name: 'RL2', password: PASSWORD }).expect(201);
    await limited.http().get('/v1/orgs').set(bearer(reg.body.accessToken)).expect(200);
  });

  it('ignores a spoofed X-Forwarded-For when no proxy is trusted', async () => {
    const direct = await bootApp({ RATE_LIMIT_AUTH_PER_MINUTE: '2', TRUST_PROXY_HOPS: '0' });
    try {
      for (let i = 0; i < 2; i++) await direct.http().post('/v1/auth/refresh').set({ 'x-forwarded-for': `203.0.113.${i}` }).send({ refreshToken: 'x' }).expect(401);
      await direct.http().post('/v1/auth/refresh').set({ 'x-forwarded-for': '203.0.113.99' }).send({ refreshToken: 'x' }).expect(429);
    } finally {
      await direct.app.close();
    }
  });

  it('counts in fixed one-minute windows', () => {
    const c = new FixedWindowCounter();
    expect(c.hit('k', 0).count).toBe(1);
    expect(c.hit('k', 59_999).count).toBe(2);
    expect(c.hit('k', 60_000)).toEqual({ count: 1, resetMs: 60_000 });
    c.sweep(200_000);
    expect(c.size).toBe(0);
  });
});
