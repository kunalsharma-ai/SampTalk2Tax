import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Bank feeds (BANK-004) against the real API and database: an owner sets up a feed for a bank
 * account, the sender posts transactions with its token, repeats are never added twice, bad
 * transactions and dates already reconciled are refused with reasons, a paused feed refuses
 * deliveries, a rotated or disconnected token stops working, and a statement-file feed takes
 * MT940; permissions, audit and tenants.
 */
const T = today();
const day = (n: number) => addDays(T, n);
const yymmdd = (d: string) => d.slice(2).replace(/-/g, '');
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let bank: string;
const s: Record<string, string> = {};
const url = (p = '') => `${org.base}/banking/feeds${p}`;
const feed = (token: string) => ({ Authorization: `Bearer ${token}` });
const tx = (id: string, n: number, amount: string, extra: Record<string, unknown> = {}) => ({ id, date: day(n), amount, description: `Feed line ${id}`, ...extra });
const lines = async () => (await ctx.http().get(`${org.base}/banking/accounts/${bank}/lines`).set(owner.auth).expect(200)).body.lines as { description: string; amount: string; status: string }[];

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Feed Owner');
  accountant = await registerUser(ctx, 'Feed Accountant');
  viewer = await registerUser(ctx, 'Feed Viewer');
  org = await createOrg(ctx, owner, { name: 'Feeding Traders Pvt Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  bank = org.acc['1120'];
});
afterAll(async () => ctx?.app.close());

describe('bank feeds', () => {
  it('lets owners set up one feed per account and shows its token once', async () => {
    const body = { accountId: bank, name: 'HDFC host-to-host', kind: 'TRANSACTIONS', expectEveryHours: 24 };
    await ctx.http().post(url()).set(viewer.auth).send(body).expect(403);
    await ctx.http().post(url()).set(accountant.auth).send(body).expect(403);
    await ctx.http().post(url()).set(owner.auth).send({ ...body, expectEveryHours: 5 }).expect(400);
    await ctx.http().post(url()).set(owner.auth).send({ ...body, accountId: org.acc['6600'] }).expect(422);
    const f = (await ctx.http().post(url()).set(owner.auth).send(body).expect(201)).body;
    expect(f).toMatchObject({ name: 'HDFC host-to-host', kind: 'TRANSACTIONS', status: 'ACTIVE', health: 'WAITING', account: { code: '1120', currency: 'INR' }, createdBy: 'Feed Owner', deliveryCount: 0 });
    expect(f.token).toMatch(/^t2tf_[A-Za-z0-9]{40}$/);
    expect(f.prefix).toBe(f.token.slice(5, 13));
    s.feed = f.id;
    s.token = f.token;
    const again = await ctx.http().post(url()).set(owner.auth).send({ ...body, name: 'Second feed' }).expect(409);
    expect(again.body.error).toBe('FEED_EXISTS');
    const list = (await ctx.http().get(url()).set(viewer.auth).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].token).toBeUndefined();
    expect(JSON.stringify(await ctx.db.collection('bank_feed_connections').findOne({ orgId: org.orgId }))).not.toContain(s.token);
  });

  it('takes transactions from the sender, never twice, and says why it refuses any', async () => {
    await ctx.http().get('/v1/bank-feed/me').expect(401);
    await ctx.http().get('/v1/bank-feed/me').set(feed('t2tf_' + 'x'.repeat(40))).expect(401);
    const me = (await ctx.http().get('/v1/bank-feed/me').set(feed(s.token)).expect(200)).body;
    expect(me).toMatchObject({ organisation: 'Feeding Traders Pvt Ltd', account: { code: '1120', currency: 'INR' }, feed: { kind: 'TRANSACTIONS', status: 'ACTIVE' } });
    const first = [tx('UTR-1', -6, '11800.00', { reference: 'UTR-1' }), tx('UTR-2', -5, '2500.00', { direction: 'DEBIT' }), tx('UTR-3', -4, '-499.50'), tx('UTR-4', -4, 120)];
    const d1 = (await ctx.http().post('/v1/bank-feed/transactions').set(feed(s.token)).send({ transactions: first }).expect(200)).body;
    expect(d1).toMatchObject({ outcome: 'IMPORTED', received: 4, imported: 3, duplicates: 0, rejected: 1 });
    expect(d1.rejections).toEqual([{ position: 4, id: 'UTR-4', reasons: ['amount sent as a number; send it as a string, like "1250.00"'] }]);
    expect((await lines()).map((l) => [l.description, l.amount, l.status]).sort()).toEqual([
      ['Feed line UTR-1', '11800.00', 'UNMATCHED'],
      ['Feed line UTR-2', '-2500.00', 'UNMATCHED'],
      ['Feed line UTR-3', '-499.50', 'UNMATCHED'],
    ]);
    const d2 = (await ctx.http().post('/v1/bank-feed/transactions').set(feed(s.token)).send({ transactions: first.slice(0, 3) }).expect(200)).body;
    expect(d2).toMatchObject({ outcome: 'NOTHING_NEW', received: 3, imported: 0, duplicates: 3, rejected: 0 });
    // Same description, date and amount but a new id: a second real transaction, so it is added.
    const d3 = (await ctx.http().post('/v1/bank-feed/transactions').set(feed(s.token)).send({ transactions: [tx('UTR-3b', -4, '-499.50', { description: 'Feed line UTR-3' })] }).expect(200)).body;
    expect(d3).toMatchObject({ outcome: 'IMPORTED', imported: 1 });
    expect(await lines()).toHaveLength(4);
    await ctx.http().post('/v1/bank-feed/statement').set(feed(s.token)).send({ fileName: 'x.sta', content: 'x' }).expect(409);
    await ctx.http().post('/v1/bank-feed/transactions').set(feed(s.token)).send({ transactions: [] }).expect(400);
    const got = (await ctx.http().get(url(`/${s.feed}`)).set(viewer.auth).expect(200)).body;
    expect(got).toMatchObject({ health: 'HEALTHY', deliveryCount: 3, linesImported: 4, lastOutcome: 'IMPORTED' });
    expect(got.deliveries.map((d: { outcome: string; imported: number }) => [d.outcome, d.imported])).toEqual([['IMPORTED', 1], ['NOTHING_NEW', 0], ['IMPORTED', 3]]);
  });

  it('refuses dates already reconciled, and shows a failing feed', async () => {
    await ctx.http().post(`${org.base}/banking/accounts/${bank}/reconciliations`).set(owner.auth).send({ statementDate: day(-20), statementBalance: '0.00', openingBalance: '0.00' }).expect(201);
    const d = (await ctx.http().post('/v1/bank-feed/transactions').set(feed(s.token)).send({ transactions: [tx('OLD-1', -25, '100.00')] }).expect(200)).body;
    expect(d).toMatchObject({ outcome: 'REJECTED', imported: 0, rejected: 1, reconciledUntil: day(-20) });
    expect(d.rejections[0]).toEqual({ position: 1, id: 'OLD-1', reasons: [`dated on or before ${day(-20)}, when this account was last reconciled`] });
    expect((await ctx.http().get(url(`/${s.feed}`)).set(owner.auth).expect(200)).body.health).toBe('FAILING');
  });

  it('pauses, rotates and disconnects', async () => {
    await ctx.http().post(url(`/${s.feed}/pause`)).set(viewer.auth).expect(403);
    expect((await ctx.http().post(url(`/${s.feed}/pause`)).set(accountant.auth).expect(200)).body.health).toBe('PAUSED');
    expect((await ctx.http().post('/v1/bank-feed/transactions').set(feed(s.token)).send({ transactions: [tx('P-1', -1, '1.00')] }).expect(409)).body.error).toBe('FEED_PAUSED');
    await ctx.http().get('/v1/bank-feed/me').set(feed(s.token)).expect(200);
    await ctx.http().post(url(`/${s.feed}/resume`)).set(accountant.auth).expect(200);
    await ctx.http().post(url(`/${s.feed}/rotate-token`)).set(accountant.auth).expect(403);
    const rotated = (await ctx.http().post(url(`/${s.feed}/rotate-token`)).set(owner.auth).expect(200)).body;
    expect(rotated.token).not.toBe(s.token);
    await ctx.http().get('/v1/bank-feed/me').set(feed(s.token)).expect(401);
    expect((await ctx.http().post('/v1/bank-feed/transactions').set(feed(rotated.token)).send({ transactions: [tx('UTR-1', -6, '11800.00')] }).expect(200)).body.outcome).toBe('NOTHING_NEW');
    expect((await ctx.http().put(url(`/${s.feed}`)).set(accountant.auth).send({ name: 'HDFC H2H', expectEveryHours: 6 }).expect(200)).body).toMatchObject({ name: 'HDFC H2H', expectEveryHours: 6 });
    const off = (await ctx.http().post(url(`/${s.feed}/disconnect`)).set(owner.auth).expect(200)).body;
    expect(off).toMatchObject({ status: 'REVOKED', health: 'REVOKED', revokedBy: 'Feed Owner' });
    await ctx.http().post('/v1/bank-feed/transactions').set(feed(rotated.token)).send({ transactions: [tx('UTR-9', -1, '1.00')] }).expect(401);
    await ctx.http().post(url(`/${s.feed}/resume`)).set(owner.auth).expect(409);
    expect(await lines()).toHaveLength(4);
  });

  it('takes statement files on a statement feed, deduplicated like uploads', async () => {
    const f = (await ctx.http().post(url()).set(owner.auth).send({ accountId: bank, name: 'MT940 drop', kind: 'STATEMENT_FILE', expectEveryHours: 24 }).expect(201)).body;
    s.fileFeed = f.id;
    const [a, b] = [day(-3), day(-2)];
    const mt940 = [':20:STMT', ':25:50200012345678', `:60F:C${yymmdd(a)}INR0,00`, `:61:${yymmdd(a)}${yymmdd(a).slice(2)}C5000,00NTRFUTR5511//N1`, ':86:NEFT ACME', `:61:${yymmdd(b)}${yymmdd(b).slice(2)}D250,00NCHG77`, ':86:BANK CHARGES', `:62F:C${yymmdd(b)}INR4750,00`].join('\n');
    const d1 = (await ctx.http().post('/v1/bank-feed/statement').set(feed(f.token)).send({ fileName: 'stmt-1.sta', content: mt940 }).expect(200)).body;
    expect(d1).toMatchObject({ outcome: 'IMPORTED', received: 2, imported: 2, duplicates: 0 });
    const d2 = (await ctx.http().post('/v1/bank-feed/statement').set(feed(f.token)).send({ fileName: 'stmt-1-again.sta', content: mt940 }).expect(200)).body;
    expect(d2).toMatchObject({ outcome: 'NOTHING_NEW', duplicates: 2 });
    const bad = (await ctx.http().post('/v1/bank-feed/statement').set(feed(f.token)).send({ fileName: 'notes.txt', content: 'hello there' }).expect(422)).body;
    expect(bad.error).toBe('FEED_FILE_UNREADABLE');
    const got = (await ctx.http().get(url(`/${f.id}`)).set(owner.auth).expect(200)).body;
    expect(got).toMatchObject({ health: 'FAILING', lastOutcome: 'FAILED', linesImported: 2 });
    expect(got.deliveries[0]).toMatchObject({ outcome: 'FAILED', fileName: 'notes.txt', error: 'Not an OFX, QIF or MT940 statement file' });
    expect(await lines()).toHaveLength(6);
  });

  it('is audited without the secret, and kept to its organisation', async () => {
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: { $regex: '^bank(_feed\\.|\\.feed_)' } }).sort({ _id: 1 }).toArray();
    expect(events.map((e) => e.action)).toEqual([
      'bank_feed.created',
      'bank.feed_lines_imported',
      'bank.feed_lines_imported',
      'bank_feed.delivery_refused',
      'bank_feed.paused',
      'bank_feed.resumed',
      'bank_feed.token_rotated',
      'bank_feed.updated',
      'bank_feed.disconnected',
      'bank_feed.created',
      'bank.feed_lines_imported',
      'bank_feed.delivery_refused',
    ]);
    // People's changes name them; what a sender delivered has no person behind it.
    expect(events.filter((e) => e.actorId === null).map((e) => e.action.split('.')[1])).toEqual(['feed_lines_imported', 'feed_lines_imported', 'delivery_refused', 'feed_lines_imported', 'delivery_refused']);
    expect(JSON.stringify(events)).not.toContain(s.token);
    const outsider = await registerUser(ctx, 'Feed Outsider');
    await ctx.http().get(url(`/${s.feed}`)).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, owner, { name: 'Other Feeding Ltd' });
    await ctx.http().get(`${other.base}/banking/feeds/${s.feed}`).set(owner.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/banking/feeds`).set(owner.auth).expect(200)).body).toEqual([]);
  });
});
