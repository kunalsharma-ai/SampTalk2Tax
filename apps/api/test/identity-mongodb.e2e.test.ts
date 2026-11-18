import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { thenOrUndo } from '../src/common/undo';
import { bootApp, Ctx, registerUser } from './helpers';


const PASSWORD = 'a-very-long-test-password';
let ctx: Ctx;
beforeAll(async () => {
  ctx = await bootApp();
});
afterAll(async () => {
  await ctx.app.close();
});

describe('people and sessions live in MongoDB', () => {
  it('a registered person is stored in MongoDB, and changes follow', async () => {
    const u = await registerUser(ctx, 'Mongo Person');
    const doc = await ctx.db.collection('users').findOne({ _id: u.id as never });
    expect(doc).toMatchObject({ email: u.email, name: 'Mongo Person', isActive: true, platformRole: null });
    expect(doc?.passwordHash).not.toContain(PASSWORD);
    const session = await ctx.db.collection('auth_sessions').findOne({ _id: u.refreshToken.split('.')[0] as never });
    expect(session?.userId).toBe(u.id);

    expect(await ctx.prisma.user.findUnique({ where: { id: u.id }, select: { email: true } })).toEqual({ email: u.email });
    await ctx.http().put('/v1/auth/me/preferences').set(u.auth).send({ language: 'hi', numberFormat: 'IN', dateFormat: 'DMY', timeZone: 'Europe/London' }).expect(200);
    expect(await ctx.prisma.user.findUnique({ where: { id: u.id }, select: { language: true, timeZone: true } })).toEqual({ language: 'hi', timeZone: 'Europe/London' });
    // Its sign-up is in the audit trail, as before.
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'user.registered', entityId: u.id } })).toBeTruthy();
  });

  it('two registrations racing for one address: exactly one wins', async () => {
    const email = `${randomUUID()}@example.test`;
    const send = () => ctx.http().post('/v1/auth/register').send({ email, name: 'Racer', password: PASSWORD });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await ctx.db.collection('users').countDocuments({ email })).toBe(1);
  });

  it('failed sign-ins at the same moment are all counted', async () => {
    const u = await registerUser(ctx);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => ctx.http().post('/v1/auth/login').send({ email: u.email, password: `wrong-password-${i}-xx` })));
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect((await ctx.db.collection('login_throttles').findOne({ _id: u.email as never }))?.failures).toBe(5);
    expect((await ctx.http().post('/v1/auth/login').send({ email: u.email, password: PASSWORD })).status).toBe(429);
  });

  it('when the record of a change fails, the change is undone', async () => {
    const undone: string[] = [];
    await expect(
      thenOrUndo(
        'result',
        async () => {
          throw new Error('record refused');
        },
        async () => {
          undone.push('change reversed');
        },
      ),
    ).rejects.toThrow('record refused');
    expect(undone).toEqual(['change reversed']);
    await expect(thenOrUndo('kept', async () => undefined, async () => { undone.push('never'); })).resolves.toBe('kept');
    expect(undone).toHaveLength(1);
  });
});
