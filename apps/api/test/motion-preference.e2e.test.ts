import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, Ctx, registerUser, TestUser } from './helpers';

/**
 * DASH-038 against the real API and database: each person chooses how much the interface moves
 * (follow the device, animate, keep still). The choice is theirs alone, kept across sign-ins,
 * checked, and left alone by clients that do not send it.
 */
let ctx: Ctx;
let a: TestUser;
let b: TestUser;
const base = { language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: null };
const me = async (u: TestUser) => (await ctx.http().get('/v1/auth/me').set(u.auth).expect(200)).body.preferences;

beforeAll(async () => {
  ctx = await bootApp();
  a = await registerUser(ctx, 'Motion A');
  b = await registerUser(ctx, 'Motion B');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('motion preference', () => {
  it('follows the device until the person chooses', async () => {
    expect((await me(a)).motion).toBe('SYSTEM');
  });

  it('keeps the person’s choice, for them only', async () => {
    const saved = (
      await ctx
        .http()
        .put('/v1/auth/me/preferences')
        .set(a.auth)
        .send({ ...base, motion: 'REDUCED' })
        .expect(200)
    ).body;
    expect(saved.motion).toBe('REDUCED');
    expect((await me(a)).motion).toBe('REDUCED');
    expect((await me(b)).motion).toBe('SYSTEM');
    expect((await ctx.db.collection('users').findOne({ _id: a.id as never }))?.motion).toBe('REDUCED');
    // A client that does not send it leaves it alone.
    expect(
      (
        await ctx
          .http()
          .put('/v1/auth/me/preferences')
          .set(a.auth)
          .send({ ...base, language: 'hi' })
          .expect(200)
      ).body,
    ).toMatchObject({ language: 'hi', motion: 'REDUCED' });
    expect(
      (
        await ctx
          .http()
          .put('/v1/auth/me/preferences')
          .set(a.auth)
          .send({ ...base, motion: 'FULL' })
          .expect(200)
      ).body.motion,
    ).toBe('FULL');
  });

  it('refuses anything else, and needs a signed-in person', async () => {
    await ctx
      .http()
      .put('/v1/auth/me/preferences')
      .set(b.auth)
      .send({ ...base, motion: 'FAST' })
      .expect(400);
    await ctx
      .http()
      .put('/v1/auth/me/preferences')
      .set(b.auth)
      .send({ ...base, motion: null })
      .expect(400);
    await ctx
      .http()
      .put('/v1/auth/me/preferences')
      .send({ ...base, motion: 'REDUCED' })
      .expect(401);
    expect((await me(b)).motion).toBe('SYSTEM');
    // The database refuses a bad value too.
    await expect(ctx.db.collection('users').updateOne({ _id: b.id as never }, { $set: { motion: 'FAST' } })).rejects.toThrow(/validation/i);
  });
});
