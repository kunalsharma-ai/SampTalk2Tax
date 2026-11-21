import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Financial transaction replay (AUDIT-017) against the real API and database: the ledger replayed
 * as recorded at a past moment shows only what was posted by then; set beside the ledger now, the
 * difference is exactly the entries posted since (a back-dated entry and a reversal); audited;
 * validation, permissions and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const FIRST = `${T.slice(0, 7)}-01`;
type Row = { code: string; name: string; recorded: string; current: string; change: string };
type Replay = { asOf: string; through: string; summary: { accounts: number; changedAccounts: number; recordedBalances: boolean; currentBalances: boolean; netChange: string; entriesSince: number }; accounts: Row[]; entriesSince: { entryNumber: number; date: string; postedBy: string | null; memo: string | null; amount: string; reverses: { entryNumber: number | null } | null; accounts: string[] }[]; moreEntries: boolean };
const R = (asOf: string, through = T, user = owner) => ctx.http().get(`${org.base}/ledger-replay?asOf=${encodeURIComponent(asOf)}&through=${through}`).set(user.auth);
const je = (date: string, amount: string, memo: string, debit = '6200') => ({ date, post: true, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc['1120'], credit: amount }] });
let rentId: string;
let cut: string;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Replay Owner');
  accountant = await registerUser(ctx, 'Replay Accountant');
  viewer = await registerUser(ctx, 'Replay Viewer');
  outsider = await registerUser(ctx, 'Replay Outsider');
  org = await createOrg(ctx, owner, { name: 'Replay Test Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Replay Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ ...je(FIRST, '100000.00', 'Capital', '3100'), lines: [{ accountId: org.acc['1120'], debit: '100000.00' }, { accountId: org.acc['3100'], credit: '100000.00' }] }).expect(201);
  rentId = (await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send(je(T, '25000.00', 'Office rent')).expect(201)).body.id;
  await new Promise((r) => setTimeout(r, 30));
  cut = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 30));
  // After the cut: a back-dated entry and a reversal of the rent.
  await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send(je(FIRST, '1800.00', 'Bank charges found late', '6900')).expect(201);
  await ctx.http().post(`${org.base}/journals/${rentId}/reverse`).set(owner.auth).send({ date: T, memo: 'Rent booked twice' }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('financial transaction replay', () => {
  it('replays the ledger as recorded at a past moment and explains the difference from now', async () => {
    const r = (await R(cut).expect(200)).body as Replay;
    expect(r.summary).toEqual({ accounts: 4, changedAccounts: 3, recordedBalances: true, currentBalances: true, netChange: '25000.00', entriesSince: 2 });
    const by = Object.fromEntries(r.accounts.map((a) => [a.code, a]));
    expect(by['1120']).toMatchObject({ recorded: '75000.00', current: '98200.00', change: '23200.00' });
    expect(by['6200']).toMatchObject({ recorded: '25000.00', current: '0.00', change: '-25000.00' });
    expect(by['6900']).toMatchObject({ recorded: '0.00', current: '1800.00', change: '1800.00' });
    expect(by['3100']).toMatchObject({ recorded: '-100000.00', current: '-100000.00', change: '0.00' });
    expect(r.accounts[0]!.code).toBe('6200');
    expect(r.entriesSince.map((e) => [e.memo, e.date, e.amount, e.postedBy])).toEqual([
      ['Bank charges found late', FIRST, '1800.00', 'Replay Accountant'],
      ['Rent booked twice', T, '25000.00', 'Replay Owner'],
    ]);
    expect(r.entriesSince[1]!.reverses).toMatchObject({ entryNumber: expect.any(Number) });
    expect(r.entriesSince[0]!.accounts.sort()).toEqual(['1120', '6900']);
  });

  it('limits the replay to entries dated up to the cut-off, and shows nothing changed for now', async () => {
    const yesterday = new Date(Date.parse(`${T}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    if (yesterday >= FIRST) {
      const r = (await R(cut, yesterday).expect(200)).body as Replay;
      expect(r.summary.entriesSince).toBe(1);
      expect(r.entriesSince.map((e) => e.memo)).toEqual(['Bank charges found late']);
    }
    const nowish = (await R(new Date().toISOString()).expect(200)).body as Replay;
    expect(nowish.summary).toMatchObject({ changedAccounts: 0, entriesSince: 0, netChange: '0.00' });
  });

  it('checks the moment and the date, audits each replay, and keeps to the audit permission and the organisation', async () => {
    expect((await R(new Date(Date.now() + 3_600_000).toISOString()).expect(422)).body.error).toBe('INVALID_REPLAY');
    await R('yesterday').expect(400);
    await R(cut, '2026-1-1').expect(400);
    await R(cut, T, viewer).expect(403);
    const audit = (await ctx.http().get(`${org.base}/audit-events?action=ledger.replayed`).set(owner.auth).expect(200)).body;
    const events = ((audit.items ?? audit) as { action: string; data: { through: string } }[]).filter((e) => e.action === 'ledger.replayed');
    expect(events.length).toBeGreaterThanOrEqual(2);
    await ctx.http().get(`${org.base}/ledger-replay?asOf=${encodeURIComponent(cut)}&through=${T}`).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/ledger-replay?asOf=${encodeURIComponent(cut)}&through=${T}`).set(outsider.auth).expect(200)).body as Replay;
    expect(theirs.accounts).toEqual([]);
  });
});
