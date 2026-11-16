import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, today } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await bootApp();
});
afterAll(async () => {
  await ctx.app.close();
});

describe('authentication', () => {
  it('registers, logs in and returns the profile', async () => {
    const u = await registerUser(ctx);
    const login = await ctx.http().post('/v1/auth/login').send({ email: u.email.toUpperCase(), password: 'a-very-long-test-password' }).expect(200);
    expect(login.body.accessToken).toBeTruthy();
    const me = await ctx.http().get('/v1/auth/me').set({ Authorization: `Bearer ${login.body.accessToken}` }).expect(200);
    expect(me.body.user.email).toBe(u.email);
  });

  it('rejects weak passwords, duplicate emails, bad credentials and missing tokens', async () => {
    await ctx.http().post('/v1/auth/register').send({ email: 'weak@example.test', name: 'W', password: 'short' }).expect(422);
    const u = await registerUser(ctx);
    await ctx.http().post('/v1/auth/register').send({ email: u.email, name: 'Dup', password: 'a-very-long-test-password' }).expect(409);
    await ctx.http().post('/v1/auth/login').send({ email: u.email, password: 'wrong-password-123' }).expect(401);
    await ctx.http().post('/v1/auth/login').send({ email: `nobody-${Date.now()}@example.test`, password: 'wrong-password-123' }).expect(401);
    await ctx.http().get('/v1/orgs').expect(401);
    await ctx.http().get('/v1/orgs').set({ Authorization: 'Bearer not-a-token' }).expect(401);
  });
});

describe('organization onboarding', () => {
  it('creates an org with a chart of accounts and the current fiscal year', async () => {
    const u = await registerUser(ctx);
    const { base, acc } = await createOrg(ctx, u);
    expect(acc['1120']).toBeTruthy();
    const periods = await ctx.http().get(`${base}/periods`).set(u.auth).expect(200);
    expect(periods.body).toHaveLength(12);
    expect(periods.body[0].startDate.slice(5)).toBe('04-01');
    const t = today();
    expect(periods.body.some((p: { startDate: string; endDate: string }) => p.startDate <= t && t <= p.endDate)).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('never exposes or accepts another tenant’s data', async () => {
    const alice = await registerUser(ctx, 'Alice');
    const bob = await registerUser(ctx, 'Bob');
    const a = await createOrg(ctx, alice, { name: 'Alice Co' });
    const b = await createOrg(ctx, bob, { name: 'Bob Co' });

    // Bob cannot see or touch Alice's org (404 so ids cannot be probed).
    await ctx.http().get(a.base).set(bob.auth).expect(404);
    await ctx.http().get(`${a.base}/accounts`).set(bob.auth).expect(404);
    await ctx.http().get(`${a.base}/reports/trial-balance?asOf=${today()}`).set(bob.auth).expect(404);
    await ctx
      .http()
      .post(`${a.base}/journals`)
      .set(bob.auth)
      .send({ date: today(), lines: [{ accountId: a.acc['1120'], debit: '1.00' }, { accountId: a.acc['4100'], credit: '1.00' }] })
      .expect(404);

    // Bob cannot post into his own org using Alice's account ids.
    const res = await ctx
      .http()
      .post(`${b.base}/journals`)
      .set(bob.auth)
      .send({ date: today(), post: true, lines: [{ accountId: a.acc['1120'], debit: '1.00' }, { accountId: b.acc['4100'], credit: '1.00' }] })
      .expect(422);
    expect(res.body.issues.join()).toMatch(/account not found/);

    // Listing orgs only returns your own.
    const mine = await ctx.http().get('/v1/orgs').set(bob.auth).expect(200);
    expect(mine.body.map((o: { id: string }) => o.id)).toEqual([b.orgId]);

    // Account lookups by id are tenant-scoped.
    await ctx.http().get(`${b.base}/accounts/${a.acc['1120']}`).set(bob.auth).expect(404);
  });

  it('rejects non-uuid org ids without leaking errors', async () => {
    const u = await registerUser(ctx);
    await ctx.http().get('/v1/orgs/not-a-uuid/accounts').set(u.auth).expect(404);
  });
});

describe('roles and permissions', () => {
  it('enforces role permissions per organization', async () => {
    const owner = await registerUser(ctx, 'Owner');
    const viewer = await registerUser(ctx, 'Viewer');
    const accountant = await registerUser(ctx, 'Accountant');
    const approver = await registerUser(ctx, 'Approver');
    const { base, acc } = await createOrg(ctx, owner);
    await ctx.http().post(`${base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    await ctx.http().post(`${base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
    await ctx.http().post(`${base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);

    const journal = { date: today(), lines: [{ accountId: acc['1120'], debit: '10.00' }, { accountId: acc['4100'], credit: '10.00' }] };

    await ctx.http().get(`${base}/reports/trial-balance?asOf=${today()}`).set(viewer.auth).expect(200);
    await ctx.http().post(`${base}/journals`).set(viewer.auth).send(journal).expect(403);
    await ctx.http().post(`${base}/accounts`).set(viewer.auth).send({ code: '9999', name: 'X', type: 'ASSET' }).expect(403);

    // Approver can post drafts but not create them; accountant can create.
    await ctx.http().post(`${base}/journals`).set(approver.auth).send(journal).expect(403);
    const draft = await ctx.http().post(`${base}/journals`).set(accountant.auth).send(journal).expect(201);
    expect(draft.body.status).toBe('DRAFT');
    const posted = await ctx.http().post(`${base}/journals/${draft.body.id}/post`).set(approver.auth).expect(200);
    expect(posted.body.status).toBe('POSTED');

    // Only owners/admins lock periods or manage members; admins cannot mint owners.
    const periods = await ctx.http().get(`${base}/periods`).set(accountant.auth).expect(200);
    await ctx.http().post(`${base}/periods/${periods.body[0].id}/lock`).set(accountant.auth).expect(403);
    await ctx.http().post(`${base}/members`).set(accountant.auth).send({ email: viewer.email, role: 'ADMIN' }).expect(403);
    const admin = await registerUser(ctx, 'Admin');
    await ctx.http().post(`${base}/members`).set(owner.auth).send({ email: admin.email, role: 'ADMIN' }).expect(201);
    const nobody = await registerUser(ctx, 'Nobody');
    await ctx.http().post(`${base}/members`).set(admin.auth).send({ email: nobody.email, role: 'OWNER' }).expect(403);

    // Audit trail is restricted from viewers.
    await ctx.http().get(`${base}/audit-events`).set(viewer.auth).expect(403);
    await ctx.http().get(`${base}/audit-events`).set(accountant.auth).expect(200);
  });
});
