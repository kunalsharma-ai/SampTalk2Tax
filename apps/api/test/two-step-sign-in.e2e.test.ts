import { totpCode, totpStep } from '@talk2tax/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

const PASSWORD = 'a-very-long-test-password';
let ctx: Ctx;
beforeAll(async () => {
  ctx = await bootApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const login = (email: string, password = PASSWORD) => ctx.http().post('/v1/auth/login').send({ email, password });
/** A code from the step after the last one used, as the app would show 30 seconds later. */
const nextCode = async (userId: string, secret: string) => {
  const row = await ctx.db.collection('user_mfa').findOne({ _id: userId as never });
  const step = Math.max(totpStep(), (row?.lastStep ?? -1) + 1);
  // Codes one step ahead are accepted (clock drift), so a second code in the same 30 s is possible.
  if (step > totpStep() + 1) throw new Error('test used too many codes in one step');
  return totpCode(secret, step * 30_000);
};

async function turnOn(u: TestUser) {
  const setup = await ctx.http().post('/v1/auth/mfa/setup').set(u.auth).send({ password: PASSWORD }).expect(200);
  const confirm = await ctx.http().post('/v1/auth/mfa/confirm').set(u.auth).send({ code: totpCode(setup.body.secret) }).expect(200);
  return { secret: setup.body.secret as string, recoveryCodes: confirm.body.recoveryCodes as string[] };
}

describe('turning two-step sign-in on', () => {
  it('needs the password, shows a secret, and only turns on with a right code', async () => {
    const u = await registerUser(ctx);
    expect((await ctx.http().get('/v1/auth/mfa').set(u.auth).expect(200)).body).toEqual({ enabled: false, pending: false, enabledAt: null, recoveryCodesLeft: 0 });
    expect((await ctx.http().post('/v1/auth/mfa/setup').set(u.auth).send({ password: 'not-the-password' }).expect(422)).body.error).toBe('WRONG_PASSWORD');

    const setup = await ctx.http().post('/v1/auth/mfa/setup').set(u.auth).send({ password: PASSWORD }).expect(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUri).toBe(`otpauth://totp/Talk2Tax%3A${encodeURIComponent(u.email)}?secret=${setup.body.secret}&issuer=Talk2Tax&algorithm=SHA1&digits=6&period=30`);
    expect((await ctx.http().get('/v1/auth/mfa').set(u.auth).expect(200)).body.pending).toBe(true);
    // The secret is stored sealed, never as typed.
    const row = await ctx.db.collection('user_mfa').findOne({ _id: u.id as never });
    expect(JSON.stringify(row)).not.toContain(setup.body.secret);

    // Still pending: the password alone signs in.
    expect((await login(u.email).expect(200)).body.accessToken).toBeTruthy();

    const wrong = totpCode(setup.body.secret, Date.now() - 5 * 60_000);
    expect((await ctx.http().post('/v1/auth/mfa/confirm').set(u.auth).send({ code: wrong }).expect(422)).body.error).toBe('MFA_CODE_INVALID');
    const ok = await ctx.http().post('/v1/auth/mfa/confirm').set(u.auth).send({ code: totpCode(setup.body.secret) }).expect(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    expect(ok.body.status).toMatchObject({ enabled: true, pending: false, recoveryCodesLeft: 10 });
    // Only hashes of the recovery codes are kept.
    const stored = await ctx.db.collection('user_mfa').findOne({ _id: u.id as never });
    expect(JSON.stringify(stored)).not.toContain(ok.body.recoveryCodes[0]);

    expect((await ctx.http().post('/v1/auth/mfa/setup').set(u.auth).send({ password: PASSWORD }).expect(409)).body.error).toBe('MFA_ALREADY_ON');
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { action: 'user.mfa_enabled', entityId: u.id } });
    expect(audit?.data).toMatchObject({ method: 'TOTP', recoveryCodes: 10 });
  });
});

describe('signing in with two-step sign-in on', () => {
  it('asks for a code after the password and signs in with it, once', async () => {
    const u = await registerUser(ctx);
    const { secret } = await turnOn(u);
    const first = await login(u.email).expect(200);
    expect(first.body).toEqual({ mfaRequired: true, challengeToken: expect.stringMatching(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/), expiresIn: 300 });
    expect(first.body.accessToken).toBeUndefined();
    // A wrong password still answers as before, without saying two-step sign-in is on.
    expect((await login(u.email, 'wrong-password-here').expect(401)).body.error).toBe('INVALID_CREDENTIALS');

    // The code that turned it on cannot be used again in the same step.
    const usedStep = (await ctx.db.collection('user_mfa').findOne({ _id: u.id as never }))!.lastStep as number;
    const replay = await ctx.http().post('/v1/auth/login/code').send({ challengeToken: first.body.challengeToken, code: totpCode(secret, usedStep * 30_000) });
    expect(replay.status).toBe(422);

    const code = await nextCode(u.id, secret);
    const done = await ctx.http().post('/v1/auth/login/code').send({ challengeToken: first.body.challengeToken, code }).expect(200);
    expect(done.body.accessToken).toBeTruthy();
    expect(done.body.user.email).toBe(u.email);
    await ctx.http().get('/v1/auth/me').set({ Authorization: `Bearer ${done.body.accessToken}` }).expect(200);
    // The challenge is spent.
    expect((await ctx.http().post('/v1/auth/login/code').send({ challengeToken: first.body.challengeToken, code }).expect(401)).body.error).toBe('MFA_CHALLENGE_EXPIRED');
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { action: 'session.created', entityId: done.body.sessionId } });
    expect(audit?.data).toMatchObject({ secondStep: 'APP' });
  });

  it('ends the challenge after five wrong codes', async () => {
    const u = await registerUser(ctx);
    await turnOn(u);
    const { challengeToken } = (await login(u.email).expect(200)).body;
    for (let i = 0; i < 4; i++) expect((await ctx.http().post('/v1/auth/login/code').send({ challengeToken, code: '000000' }).expect(422)).body.error).toBe('MFA_CODE_INVALID');
    expect((await ctx.http().post('/v1/auth/login/code').send({ challengeToken, code: '000000' }).expect(401)).body.error).toBe('MFA_CHALLENGE_EXPIRED');
    expect((await ctx.http().post('/v1/auth/login/code').send({ challengeToken, code: '111111' }).expect(401)).body.error).toBe('MFA_CHALLENGE_EXPIRED');
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'user.mfa_challenge_failed', entityId: u.id } })).toBeTruthy();
  });

  it('refuses expired, forged and malformed challenges', async () => {
    const u = await registerUser(ctx);
    const { secret } = await turnOn(u);
    const { challengeToken } = (await login(u.email).expect(200)).body;
    const [id] = challengeToken.split('.');
    for (const t of ['nope', `${id}.${'a'.repeat(43)}`]) {
      expect((await ctx.http().post('/v1/auth/login/code').send({ challengeToken: t, code: await nextCode(u.id, secret) }).expect(401)).body.error).toBe('MFA_CHALLENGE_EXPIRED');
    }
    await ctx.db.collection('mfa_challenges').updateOne({ _id: id as never }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ctx.http().post('/v1/auth/login/code').send({ challengeToken, code: await nextCode(u.id, secret) }).expect(401)).body.error).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it('accepts each recovery code once, in any case or spacing', async () => {
    const u = await registerUser(ctx);
    const { recoveryCodes } = await turnOn(u);
    const c1 = (await login(u.email).expect(200)).body.challengeToken;
    const typed = recoveryCodes[3]!.toLowerCase().replace(/-/g, ' ');
    const done = await ctx.http().post('/v1/auth/login/code').send({ challengeToken: c1, code: typed }).expect(200);
    expect((await ctx.http().get('/v1/auth/mfa').set({ Authorization: `Bearer ${done.body.accessToken}` }).expect(200)).body.recoveryCodesLeft).toBe(9);
    const c2 = (await login(u.email).expect(200)).body.challengeToken;
    expect((await ctx.http().post('/v1/auth/login/code').send({ challengeToken: c2, code: recoveryCodes[3] }).expect(422)).body.error).toBe('MFA_CODE_INVALID');
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'user.mfa_recovery_code_used', entityId: u.id } })).toBeTruthy();
  });
});

describe('managing two-step sign-in', () => {
  it('replaces recovery codes only with an app code, and the old ones stop working', async () => {
    const u = await registerUser(ctx);
    const { secret, recoveryCodes } = await turnOn(u);
    expect((await ctx.http().post('/v1/auth/mfa/recovery-codes').set(u.auth).send({ code: recoveryCodes[0] }).expect(422)).body.error).toBe('MFA_CODE_INVALID');
    const fresh = await ctx.http().post('/v1/auth/mfa/recovery-codes').set(u.auth).send({ code: await nextCode(u.id, secret) }).expect(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    expect(fresh.body.recoveryCodes).not.toContain(recoveryCodes[0]);
    const c = (await login(u.email).expect(200)).body.challengeToken;
    expect((await ctx.http().post('/v1/auth/login/code').send({ challengeToken: c, code: recoveryCodes[0] }).expect(422)).body.error).toBe('MFA_CODE_INVALID');
    await ctx.http().post('/v1/auth/login/code').send({ challengeToken: c, code: fresh.body.recoveryCodes[0] }).expect(200);
  });

  it('turns off with the password and a code, after which the password alone signs in', async () => {
    const u = await registerUser(ctx);
    const { recoveryCodes } = await turnOn(u);
    expect((await ctx.http().post('/v1/auth/mfa/disable').set(u.auth).send({ password: 'wrong-password-here', code: recoveryCodes[0] }).expect(422)).body.error).toBe('WRONG_PASSWORD');
    expect((await ctx.http().post('/v1/auth/mfa/disable').set(u.auth).send({ password: PASSWORD, code: '123456' }).expect(422)).body.error).toBe('MFA_CODE_INVALID');
    const off = await ctx.http().post('/v1/auth/mfa/disable').set(u.auth).send({ password: PASSWORD, code: recoveryCodes[0] }).expect(200);
    expect(off.body.enabled).toBe(false);
    expect((await login(u.email).expect(200)).body.accessToken).toBeTruthy();
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'user.mfa_disabled', entityId: u.id } })).toBeTruthy();
  });

  it('the data layer refuses swapping an active secret or reusing a spent step', async () => {
    const u = await registerUser(ctx);
    await turnOn(u);
    const { userMfa } = await import('../src/db/collections/identity');
    const c = ctx.store.collection(userMfa);
    await expect(c.updateOne({ id: u.id }, { $set: { secretCipher: 'something-else' } })).rejects.toThrow(/cannot be swapped/);
    await expect(c.updateOne({ id: u.id }, { $set: { lastStep: 1 } })).rejects.toThrow(/cannot be made usable again/);
    await expect(c.updateOne({ id: u.id }, { $set: { enabledAt: null } })).rejects.toThrow(/records when it was turned on/);
  });
});

describe('an organisation that requires two-step sign-in', () => {
  it('can only be required by someone who has it on, and shuts out members without it until they turn it on', async () => {
    const owner = await registerUser(ctx);
    const org = await createOrg(ctx, owner);
    const viewer = await registerUser(ctx);
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);

    expect((await ctx.http().get(`${org.base}/security`).set(owner.auth).expect(200)).body).toMatchObject({ requireTwoStep: false, membersWithoutTwoStep: 2, youHaveTwoStep: false });
    expect((await ctx.http().put(`${org.base}/security`).set(owner.auth).send({ requireTwoStep: true }).expect(409)).body.error).toBe('MFA_NEEDED_FIRST');
    // Only members.manage may change it.
    await ctx.http().put(`${org.base}/security`).set(viewer.auth).send({ requireTwoStep: false }).expect(403);

    await turnOn(owner);
    const on = await ctx.http().put(`${org.base}/security`).set(owner.auth).send({ requireTwoStep: true }).expect(200);
    expect(on.body).toMatchObject({ requireTwoStep: true, membersWithoutTwoStep: 1, youHaveTwoStep: true, updatedBy: 'Test User' });

    // The viewer is refused everywhere in the organisation, but sees why in the list of organisations.
    expect((await ctx.http().get(`${org.base}/accounts`).set(viewer.auth).expect(403)).body.error).toBe('MFA_REQUIRED');
    expect((await ctx.http().get(org.base).set(viewer.auth).expect(403)).body.error).toBe('MFA_REQUIRED');
    const listed = (await ctx.http().get('/v1/orgs').set(viewer.auth).expect(200)).body.find((o: { id: string }) => o.id === org.orgId);
    expect(listed.twoStep).toEqual({ required: true, satisfied: false });
    // The owner, who has it on, carries on.
    await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200);
    const members = (await ctx.http().get(`${org.base}/members`).set(owner.auth).expect(200)).body as { userId: string; twoStepOn: boolean }[];
    expect(members.find((m) => m.userId === owner.id)?.twoStepOn).toBe(true);
    expect(members.find((m) => m.userId === viewer.id)?.twoStepOn).toBe(false);

    // Turning it on (with the viewer's own account routes, which stay open) lets the viewer in.
    await turnOn(viewer);
    await ctx.http().get(`${org.base}/accounts`).set(viewer.auth).expect(200);
    expect((await ctx.http().get('/v1/orgs').set(viewer.auth).expect(200)).body.find((o: { id: string }) => o.id === org.orgId).twoStep).toEqual({ required: true, satisfied: true });

    // Other organisations of the viewer are not affected by this one's rule.
    const other = await createOrg(ctx, viewer);
    expect((await ctx.http().get('/v1/orgs').set(viewer.auth).expect(200)).body.find((o: { id: string }) => o.id === other.orgId).twoStep).toEqual({ required: false, satisfied: true });

    await ctx.http().put(`${org.base}/security`).set(owner.auth).send({ requireTwoStep: false }).expect(200);
    const actions = (await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'org.two_step' } }, orderBy: { id: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(['org.two_step_required', 'org.two_step_not_required']);
  });
});
