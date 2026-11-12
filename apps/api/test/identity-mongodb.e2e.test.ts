import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { thenInPostgres } from '../src/db/postgres-mirror.service';
import { bootApp, Ctx, registerUser } from './helpers';
import { postgresOnly } from '../src/db/mirror-writes';
import { postgresOff } from '../src/db/counters';

/** Reads the PostgreSQL copy itself (reads through the API come from MongoDB). */
const pg = () => postgresOnly(ctx.prisma);

const PASSWORD = 'a-very-long-test-password';
let ctx: Ctx;
beforeAll(async () => {
  ctx = await bootApp();
});
afterAll(async () => {
  await ctx.app.close();
});

// These check the PostgreSQL copy kept while both databases run, so only while PostgreSQL does.
describe.skipIf(postgresOff())('people and sessions live in MongoDB', () => {
  it('a registered person is stored in MongoDB, with a copy in PostgreSQL that follows changes', async () => {
    const u = await registerUser(ctx, 'Mongo Person');
    const doc = await ctx.db.collection('users').findOne({ _id: u.id as never });
    expect(doc).toMatchObject({ email: u.email, name: 'Mongo Person', isActive: true, platformRole: null });
    expect(doc?.passwordHash).not.toContain(PASSWORD);
    const session = await ctx.db.collection('auth_sessions').findOne({ _id: u.refreshToken.split('.')[0] as never });
    expect(session?.userId).toBe(u.id);

    // Modules still on PostgreSQL point at people with foreign keys, so the copy must exist.
    expect(await pg().user.findUnique({ where: { id: u.id }, select: { email: true } })).toEqual({ email: u.email });
    await ctx.http().put('/v1/auth/me/preferences').set(u.auth).send({ language: 'hi', numberFormat: 'IN', dateFormat: 'DMY', timeZone: 'Europe/London' }).expect(200);
    expect(await pg().user.findUnique({ where: { id: u.id }, select: { language: true, timeZone: true } })).toEqual({ language: 'hi', timeZone: 'Europe/London' });
    // Its sign-up is in the audit trail, as before.
    expect(await pg().auditEvent.findFirst({ where: { action: 'user.registered', entityId: u.id } })).toBeTruthy();
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

  it('when the PostgreSQL half of a change fails, the MongoDB half is undone', async () => {
    const undone: string[] = [];
    await expect(
      thenInPostgres(
        'result',
        async () => {
          throw new Error('postgres refused');
        },
        async () => {
          undone.push('mongo change reversed');
        },
      ),
    ).rejects.toThrow('postgres refused');
    expect(undone).toEqual(['mongo change reversed']);
    await expect(thenInPostgres('kept', async () => undefined, async () => { undone.push('never'); })).resolves.toBe('kept');
    expect(undone).toHaveLength(1);
  });
});

// A copy from PostgreSQL, so only while it runs.
describe.skipIf(postgresOff())('copying records made before the move', () => {
  it('copies people and sessions that exist only in PostgreSQL, once', async () => {
    const { copyFromPostgres } = await import('../src/db/copy-from-postgres');
    const id = randomUUID();
    const email = `${id}@example.test`;
    const now = new Date();
    await ctx.prisma.user.create({ data: { id, email, name: 'Before The Move', passwordHash: 'scrypt$x' } });
    await ctx.prisma.authSession.create({ data: { userId: id, secretHash: 'h', expiresAt: new Date(now.getTime() + 86_400_000) } });
    const first = await copyFromPostgres(ctx.prisma, ctx.store, () => undefined);
    expect(first.users).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.collection('users').findOne({ _id: id as never })).toMatchObject({ email, name: 'Before The Move', language: 'en' });
    expect(await ctx.db.collection('auth_sessions').countDocuments({ userId: id })).toBe(1);
    const again = await copyFromPostgres(ctx.prisma, ctx.store, () => undefined);
    expect(again).toMatchObject({ users: 0, journal_entries: 0, documents: 0, expense_claims: 0, tax_rates: 0, pay_runs: 0, crm_leads: 0 });
    expect(Object.entries(again).filter(([, n]) => n !== 0)).toEqual([]);
    // The copy runs over the whole shared test database, which grows with every run.
  }, 120_000);
});
