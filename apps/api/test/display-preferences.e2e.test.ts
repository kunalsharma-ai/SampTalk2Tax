import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/** Each person's language and formats, and each organisation's time zone, against the real API. */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Prefs Owner');
  accountant = await registerUser(ctx, 'Prefs Accountant');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('my preferences', () => {
  it('start in English with formats that follow the currency, and the organisation time zone', async () => {
    const me = (await ctx.http().get('/v1/auth/me').set(owner.auth).expect(200)).body;
    expect(me.preferences).toEqual({ language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null });
    expect(me.organizations[0]).toMatchObject({ id: org.orgId, timeZone: 'Asia/Kolkata' });
  });

  it('are saved for me only, and refuse unknown values', async () => {
    const saved = (await ctx.http().put('/v1/auth/me/preferences').set(owner.auth).send({ language: 'hi', numberFormat: 'INTL', dateFormat: 'YMD', timeZone: 'Europe/London' }).expect(200)).body;
    expect(saved).toEqual({ language: 'hi', numberFormat: 'INTL', dateFormat: 'YMD', timeZone: 'Europe/London' });
    expect((await ctx.http().get('/v1/auth/me').set(owner.auth).expect(200)).body.preferences.language).toBe('hi');
    expect((await ctx.http().get('/v1/auth/me').set(accountant.auth).expect(200)).body.preferences.language).toBe('en');

    const bad = await ctx.http().put('/v1/auth/me/preferences').set(owner.auth).send({ language: 'fr', numberFormat: 'IN', dateFormat: 'DMY', timeZone: 'IST' }).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/Choose a time zone such as Asia\/Kolkata/);
    await ctx.http().put('/v1/auth/me/preferences').set(owner.auth).send({ language: 'en', numberFormat: 'IN', dateFormat: 'DMY', timeZone: null, extra: 1 }).expect(400);
    // The database refuses values the API would never send.
    // The collection validator refuses what the API's own checks would (even for raw writes).
    await expect(ctx.db.collection('users').updateOne({ _id: owner.id as never }, { $set: { numberFormat: 'XX' } })).rejects.toThrow(/validation/i);
    await expect(ctx.db.collection('users').updateOne({ _id: owner.id as never }, { $set: { timeZone: "x'; drop" } })).rejects.toThrow(/validation/i);
    // Back to the organisation's zone.
    expect((await ctx.http().put('/v1/auth/me/preferences').set(owner.auth).send({ language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null }).expect(200)).body.timeZone).toBeNull();
  });

  it('need a signed-in person', async () => {
    await ctx.http().put('/v1/auth/me/preferences').send({ language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null }).expect(401);
  });
});

describe('organisation time zone', () => {
  it('is changed by those who manage the organisation, checked, and audited', async () => {
    await ctx.http().put(`${org.base}/time-zone`).set(accountant.auth).send({ timeZone: 'Asia/Dubai' }).expect(403);
    const bad = await ctx.http().put(`${org.base}/time-zone`).set(owner.auth).send({ timeZone: 'Asia/Atlantis' }).expect(422);
    expect(bad.body).toMatchObject({ error: 'INVALID_TIME_ZONE' });
    const o = (await ctx.http().put(`${org.base}/time-zone`).set(owner.auth).send({ timeZone: 'Asia/Dubai' }).expect(200)).body;
    expect(o.timeZone).toBe('Asia/Dubai');
    expect((await ctx.http().get(org.base).set(accountant.auth).expect(200)).body.timeZone).toBe('Asia/Dubai');
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'org.time_zone_changed' } });
    expect(audit?.data).toEqual({ before: 'Asia/Kolkata', after: 'Asia/Dubai' });
  });
});
