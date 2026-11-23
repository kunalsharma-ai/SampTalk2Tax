import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Company cards (EXP-011 corporate cards, EXP-012 virtual cards) against the real API and
 * database: an owner sets up a card programme (its token shown once), finance adds a corporate
 * card and asks for a virtual one, the provider reads the controls and confirms the virtual card,
 * sends transactions (never twice, a settled one replacing its authorisation, bad ones refused
 * with reasons), the cardholder explains their spending, finance posts it to the books (Dr
 * expense, Cr Credit Card Payable) or excludes it; a matching expense claim line is shown;
 * freezing shows to the provider; disconnecting stops the token; permissions and tenants.
 */
const T = today();
const day = (n: number) => addDays(T, n);
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let employee: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const s: Record<string, string> = {};
const url = (p = '') => `${org.base}/company-cards${p}`;
const dc = (j: { lines: { accountId: string; debit: string; credit: string }[] }) => j.lines.map((l) => `${l.accountId} ${Number(l.debit) ? `Dr ${l.debit}` : `Cr ${l.credit}`}`); // not money: test labels
const feed = () => ({ Authorization: `Bearer ${s.token}` });

async function balance(accountId: string) {
  const tb = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${T}`).set(owner.auth).expect(200)).body;
  const row = (tb.rows ?? tb.accounts ?? tb.lines).find((r: { accountId: string }) => r.accountId === accountId);
  return row ? { debit: row.debit, credit: row.credit } : { debit: '0.00', credit: '0.00' };
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Card Owner');
  accountant = await registerUser(ctx, 'Card Accountant');
  employee = await registerUser(ctx, 'Card Holder');
  viewer = await registerUser(ctx, 'Card Viewer');
  org = await createOrg(ctx, owner, { name: 'Card Carrying Pvt Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [employee, 'EMPLOYEE'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => ctx?.app.close());

describe('company cards', () => {
  it('lets owners set up a card programme and shows its token once', async () => {
    const body = { name: 'Corporate cards', provider: 'Synthetic Card Co', liabilityAccountId: org.acc['2150'] };
    await ctx.http().post(url('/programs')).set(accountant.auth).send(body).expect(403);
    await ctx.http().post(url('/programs')).set(viewer.auth).send(body).expect(403);
    const wrong = await ctx.http().post(url('/programs')).set(owner.auth).send({ ...body, liabilityAccountId: org.acc['6600'] }).expect(422);
    expect(wrong.body.error).toBe('INVALID_ACCOUNT');
    const p = (await ctx.http().post(url('/programs')).set(owner.auth).send(body).expect(201)).body;
    expect(p).toMatchObject({ name: 'Corporate cards', provider: 'Synthetic Card Co', currency: 'INR', status: 'ACTIVE', account: { name: '2150 Credit Card Payable' }, createdBy: 'Card Owner' });
    expect(p.token).toMatch(/^t2tc_[A-Za-z0-9]{40}$/);
    expect(p.prefix).toBe(p.token.slice(5, 13));
    s.program = p.id;
    s.token = p.token;
    const o = (await ctx.http().get(url()).set(accountant.auth).expect(200)).body;
    expect(o.programs).toHaveLength(1);
    expect(o.programs[0].token).toBeUndefined();
    expect(JSON.stringify(await ctx.db.collection('card_programs').findOne({ orgId: org.orgId }))).not.toContain(s.token);
  });

  it('adds a corporate card and asks for a virtual one, with only the last four digits', async () => {
    const base = { programId: s.program, holderId: employee.id, monthlyLimit: '50000.00' };
    await ctx.http().post(url('/cards')).set(employee.auth).send({ ...base, kind: 'CORPORATE', label: 'Travel card', last4: '4242' }).expect(403);
    await ctx.http().post(url('/cards')).set(accountant.auth).send({ ...base, kind: 'CORPORATE', label: 'Travel card', last4: '4242424242424242' }).expect(400);
    expect((await ctx.http().post(url('/cards')).set(accountant.auth).send({ ...base, kind: 'CORPORATE', label: 'Travel card' }).expect(422)).body.error).toBe('LAST4_REQUIRED');
    expect((await ctx.http().post(url('/cards')).set(accountant.auth).send({ ...base, holderId: '00000000-0000-4000-8000-000000000000', kind: 'CORPORATE', label: 'Nobody', last4: '1111' }).expect(422)).body.error).toBe('INVALID_HOLDER');
    const corp = (await ctx.http().post(url('/cards')).set(accountant.auth).send({ ...base, kind: 'CORPORATE', label: 'Travel card', last4: '4242', expires: `${Number(T.slice(0, 4)) + 3}-12`, providerRef: 'card_travel_1' }).expect(201)).body;
    expect(corp).toMatchObject({ reference: 'CARD-0001', kind: 'CORPORATE', status: 'ACTIVE', last4: '4242', holder: { name: 'Card Holder' }, limit: '50000.00', spent: '0.00', remaining: '50000.00', over: false });
    s.corp = corp.id;
    expect((await ctx.http().post(url('/cards')).set(accountant.auth).send({ ...base, kind: 'VIRTUAL', label: 'Software', last4: '9999' }).expect(422)).body.error).toBe('VIRTUAL_FROM_PROVIDER');
    const virt = (await ctx.http().post(url('/cards')).set(accountant.auth).send({ ...base, kind: 'VIRTUAL', label: 'Software subscriptions', monthlyLimit: '5000' }).expect(201)).body;
    expect(virt).toMatchObject({ reference: 'CARD-0002', kind: 'VIRTUAL', status: 'REQUESTED', last4: null, limit: '5000.00' });
    s.virt = virt.id;
  });

  it('lets the provider read the controls and confirm the virtual card', async () => {
    await ctx.http().get('/v1/card-feed/me').expect(401);
    await ctx.http().get('/v1/card-feed/me').set({ Authorization: 'Bearer t2tc_nottherightoneatallnottherightoneatall1' }).expect(401);
    const me = (await ctx.http().get('/v1/card-feed/me').set(feed()).expect(200)).body;
    expect(me).toMatchObject({ programme: { name: 'Corporate cards', currency: 'INR' }, organisation: 'Card Carrying Pvt Ltd', cards: 2, waitingToIssue: 1 });
    const cards = (await ctx.http().get('/v1/card-feed/cards').set(feed()).expect(200)).body.cards;
    expect(cards.map((c: { reference: string; status: string }) => `${c.reference} ${c.status}`)).toEqual(['CARD-0001 ACTIVE', 'CARD-0002 REQUESTED']);
    expect(cards[0]).toMatchObject({ holder: 'Card Holder', monthlyLimit: '50000.00', last4: '4242' });
    const exp = `${Number(T.slice(0, 4)) + 2}-06`;
    await ctx.http().post(`/v1/card-feed/cards/${s.virt}/issued`).set(feed()).send({ providerRef: 'vc_77', last4: '12', expires: exp }).expect(400);
    const done = (await ctx.http().post(`/v1/card-feed/cards/${s.virt}/issued`).set(feed()).send({ providerRef: 'vc_77', last4: '7777', expires: exp }).expect(200)).body;
    expect(done).toMatchObject({ reference: 'CARD-0002', status: 'ACTIVE', last4: '7777', expires: exp });
    expect((await ctx.http().post(`/v1/card-feed/cards/${s.virt}/issued`).set(feed()).send({ providerRef: 'vc_77', last4: '7777', expires: exp }).expect(409)).body.error).toBe('CARD_STATE');
  });

  it('takes transactions, never twice, settles authorisations and says why it refuses any', async () => {
    const r = (
      await ctx
        .http()
        .post('/v1/card-feed/transactions')
        .set(feed())
        .send({
          transactions: [
            { id: 'tx-1', card: 'card_travel_1', date: T, amount: '1180.00', merchant: 'Synthetic Airways', mcc: '4511' },
            { id: 'tx-2', card: '7777', date: T, amount: '2999.00', merchant: 'Synthetic Cloud', state: 'AUTHORISED' },
            { id: 'tx-3', card: '4242', date: T, amount: '-200.00', merchant: 'Synthetic Airways refund' },
            { id: 'tx-4', card: '4242', date: T, amount: 12.5, merchant: 'As a number' },
            { id: 'tx-5', card: '0000', date: T, amount: '10.00', merchant: 'No such card' },
            { id: 'tx-6', card: '4242', date: day(5), amount: '10.00', merchant: 'Future', currency: 'USD' },
            { id: 'tx-7', card: 'card_travel_1', date: T, amount: '850.00', merchant: 'Synthetic Diner' },
          ],
        })
        .expect(200)
    ).body;
    expect(r).toMatchObject({ received: 7, added: 4, settled: 0, duplicates: 0, rejected: 3 });
    expect(r.rejections.map((x: { id: string }) => x.id)).toEqual(['tx-4', 'tx-5', 'tx-6']);
    expect(r.rejections[2].reasons.join('; ')).toContain('dated in the future');
    expect(r.rejections[2].reasons.join('; ')).toContain('this programme is in INR');
    const again = (await ctx.http().post('/v1/card-feed/transactions').set(feed()).send({ transactions: [{ id: 'tx-1', card: '4242', date: T, amount: '1180.00', merchant: 'Synthetic Airways' }, { id: 'tx-2', card: '7777', date: T, amount: '3010.00', merchant: 'Synthetic Cloud Inc' }] }).expect(200)).body;
    expect(again).toMatchObject({ added: 0, settled: 1, duplicates: 1 });
    const list = (await ctx.http().get(url('/transactions')).set(accountant.auth).expect(200)).body;
    expect(list).toHaveLength(4);
    const cloud = list.find((t: { externalId: string }) => t.externalId === 'tx-2');
    expect(cloud).toMatchObject({ amount: '3010', state: 'SETTLED', merchant: 'Synthetic Cloud Inc', status: 'UNCODED', card: { reference: 'CARD-0002', last4: '7777' } });
    const o = (await ctx.http().get(url()).set(accountant.auth).expect(200)).body;
    expect(o.cards.find((c: { id: string }) => c.id === s.corp)).toMatchObject({ spent: '1830.00', remaining: '48170.00', usedPercent: 4 });
    expect(o.cards.find((c: { id: string }) => c.id === s.virt)).toMatchObject({ spent: '3010.00' });
    expect(o.waiting).toEqual({ uncoded: 4, coded: 0 });
    for (const t of list) s[t.externalId] = t.id;
  });

  it('shows the cardholder their own spending and a matching expense claim line', async () => {
    const c = (await ctx.http().post(`${org.base}/expense-claims`).set(employee.auth).send({ title: 'Dinner with client (synthetic)', lines: [{ date: T, accountId: org.acc['6600'], merchant: 'Synthetic Diner', amount: '850.00' }] }).expect(201)).body;
    await ctx.http().post(`${org.base}/expense-claims/${c.id}/submit`).set(employee.auth).send({}).expect(200);
    const mine = (await ctx.http().get(url()).set(employee.auth).expect(200)).body;
    expect(mine.programs).toEqual([]);
    expect(mine.cards).toHaveLength(2);
    const txns = (await ctx.http().get(url('/transactions')).set(employee.auth).expect(200)).body;
    const diner = txns.find((t: { externalId: string }) => t.externalId === 'tx-7');
    expect(diner.claimMatches).toEqual([expect.objectContaining({ claimNumber: c.number, claimStatus: 'SUBMITTED', lineNo: 1 })]);
    expect(diner.canCode).toBe(true);
    expect(txns.find((t: { externalId: string }) => t.externalId === 'tx-1').claimMatches).toEqual([]);
    // Someone else's spending is not theirs to see or explain.
    const other = await registerUser(ctx, 'Other Employee');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: other.email, role: 'EMPLOYEE' }).expect(201);
    expect((await ctx.http().get(url('/transactions')).set(other.auth).expect(200)).body).toEqual([]);
    expect((await ctx.http().post(url(`/transactions/${s['tx-1']}/code`)).set(other.auth).send({ accountId: org.acc['6700'], note: null }).expect(403)).body.error).toBe('FORBIDDEN');
  });

  it('lets the cardholder explain spending and finance post it to the books', async () => {
    expect((await ctx.http().post(url(`/transactions/${s['tx-1']}/code`)).set(employee.auth).send({ accountId: org.acc['2150'], note: null }).expect(422)).body.error).toBe('INVALID_ACCOUNT');
    expect((await ctx.http().post(url(`/transactions/${s['tx-1']}/post`)).set(accountant.auth).send({}).expect(409)).body.error).toBe('NOT_CODED');
    const coded = (await ctx.http().post(url(`/transactions/${s['tx-1']}/code`)).set(employee.auth).send({ accountId: org.acc['6700'], note: 'Flight to the Pune client' }).expect(200)).body;
    expect(coded).toMatchObject({ status: 'CODED', account: { code: '6700' }, note: 'Flight to the Pune client', codedBy: 'Card Holder' });
    await ctx.http().post(url(`/transactions/${s['tx-1']}/post`)).set(employee.auth).send({}).expect(403);
    const before = await balance(org.acc['2150']);
    const posted = (await ctx.http().post(url(`/transactions/${s['tx-1']}/post`)).set(accountant.auth).send({}).expect(200)).body;
    expect(posted).toMatchObject({ status: 'POSTED', postedBy: 'Card Accountant' });
    expect(posted.journalEntryNumber).toBeGreaterThan(0);
    const je = (await ctx.http().get(`${org.base}/journals/${posted.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(je.source).toBe('EXPENSE');
    expect(dc(je)).toEqual([`${org.acc['6700']} Dr 1180.00`, `${org.acc['2150']} Cr 1180.00`]);
    expect(je.lines[0].description).toBe('Synthetic Airways · Flight to the Pune client');
    const after = await balance(org.acc['2150']);
    expect(Number(after.credit) - Number(before.credit)).toBe(1180); // not money: a test comparison
    expect((await ctx.http().post(url(`/transactions/${s['tx-1']}/post`)).set(accountant.auth).send({}).expect(409)).body.error).toBe('NOT_CODED');
    expect((await ctx.http().post(url(`/transactions/${s['tx-1']}/code`)).set(employee.auth).send({ accountId: org.acc['6600'], note: null }).expect(409)).body.error).toBe('TXN_FINAL');
    // A refund posts the other way round.
    await ctx.http().post(url(`/transactions/${s['tx-3']}/code`)).set(accountant.auth).send({ accountId: org.acc['6700'], note: 'Seat refund' }).expect(200);
    const refund = (await ctx.http().post(url(`/transactions/${s['tx-3']}/post`)).set(accountant.auth).send({}).expect(200)).body;
    const rje = (await ctx.http().get(`${org.base}/journals/${refund.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(dc(rje)).toEqual([`${org.acc['2150']} Dr 200.00`, `${org.acc['6700']} Cr 200.00`]);
    // A settled transaction replaced the authorisation, so it can be posted now.
    await ctx.http().post(url(`/transactions/${s['tx-2']}/code`)).set(accountant.auth).send({ accountId: org.acc['6400'], note: null }).expect(200);
    await ctx.http().post(url(`/transactions/${s['tx-2']}/post`)).set(accountant.auth).send({}).expect(200);
  });

  it('excludes spending with a reason', async () => {
    await ctx.http().post(url(`/transactions/${s['tx-7']}/exclude`)).set(employee.auth).send({ reason: 'Claimed on an expense claim' }).expect(403);
    await ctx.http().post(url(`/transactions/${s['tx-7']}/exclude`)).set(accountant.auth).send({ reason: '' }).expect(400);
    const x = (await ctx.http().post(url(`/transactions/${s['tx-7']}/exclude`)).set(accountant.auth).send({ reason: 'Personal spending; the employee pays it back' }).expect(200)).body;
    expect(x).toMatchObject({ status: 'EXCLUDED', excludedReason: 'Personal spending; the employee pays it back', claimMatches: [] });
    const o = (await ctx.http().get(url()).set(accountant.auth).expect(200)).body;
    expect(o.cards.find((c: { id: string }) => c.id === s.corp).spent).toBe('980.00');
    expect(o.waiting).toEqual({ uncoded: 0, coded: 0 });
  });

  it('freezes, changes limits and cancels cards, which the provider sees', async () => {
    await ctx.http().post(url(`/cards/${s.virt}/control`)).set(viewer.auth).send({ action: 'FREEZE' }).expect(403);
    expect((await ctx.http().post(url(`/cards/${s.virt}/control`)).set(accountant.auth).send({ action: 'FREEZE', note: 'Lost laptop' }).expect(200)).body.status).toBe('FROZEN');
    expect((await ctx.http().post(url(`/cards/${s.virt}/control`)).set(accountant.auth).send({ action: 'FREEZE' }).expect(409)).body.error).toBe('CARD_STATE');
    const limited = (await ctx.http().post(url(`/cards/${s.corp}/control`)).set(accountant.auth).send({ action: 'LIMIT', monthlyLimit: '500' }).expect(200)).body;
    expect(limited).toMatchObject({ limit: '500.00', over: true, remaining: '0.00' });
    let cards = (await ctx.http().get('/v1/card-feed/cards').set(feed()).expect(200)).body.cards;
    expect(cards.map((c: { status: string; monthlyLimit: string | null }) => `${c.status} ${c.monthlyLimit}`)).toEqual(['ACTIVE 500.00', 'FROZEN 5000.00']);
    await ctx.http().post(url(`/cards/${s.virt}/control`)).set(accountant.auth).send({ action: 'UNFREEZE' }).expect(200);
    const cancelled = (await ctx.http().post(url(`/cards/${s.virt}/control`)).set(accountant.auth).send({ action: 'CANCEL' }).expect(200)).body;
    expect(cancelled.history.map((h: { action: string }) => h.action)).toEqual(['REQUESTED', 'ISSUED', 'FROZEN', 'UNFROZEN', 'CANCELLED']);
    expect((await ctx.http().post(url(`/cards/${s.virt}/control`)).set(accountant.auth).send({ action: 'UNFREEZE' }).expect(409)).body.error).toBe('CARD_CANCELLED');
    cards = (await ctx.http().get('/v1/card-feed/cards').set(feed()).expect(200)).body.cards;
    expect(cards[1].status).toBe('CANCELLED');
  });

  it('keeps an audit trail, keeps tenants apart and stops a disconnected token', async () => {
    const events = (await ctx.http().get(`${org.base}/audit-events?limit=200`).set(owner.auth).expect(200)).body;
    const actions = (events.items ?? events).map((e: { action: string }) => e.action);
    for (const a of ['card_program.created', 'company_card.added', 'company_card.requested', 'company_card.issued', 'card_transaction.coded', 'card_transaction.posted', 'card_transaction.excluded', 'company_card.frozen', 'company_card.cancelled']) expect(actions).toContain(a);
    expect(JSON.stringify(events)).not.toContain(s.token);
    const stranger = await registerUser(ctx, 'Card Stranger');
    const other = await createOrg(ctx, stranger, { name: 'Other Card Org' });
    const theirs = (await ctx.http().get(`${other.base}/company-cards`).set(stranger.auth).expect(200)).body;
    expect(theirs).toMatchObject({ programs: [], cards: [] });
    await ctx.http().post(`${other.base}/company-cards/transactions/${s['tx-3']}/exclude`).set(stranger.auth).send({ reason: 'Not mine at all' }).expect(404);
    await ctx.http().get(url()).set(stranger.auth).expect(404);
    const rotated = (await ctx.http().post(url(`/programs/${s.program}/rotate-token`)).set(owner.auth).send({}).expect(200)).body;
    await ctx.http().get('/v1/card-feed/me').set(feed()).expect(401);
    s.token = rotated.token;
    await ctx.http().get('/v1/card-feed/me').set(feed()).expect(200);
    await ctx.http().post(url(`/programs/${s.program}/disconnect`)).set(owner.auth).send({}).expect(200);
    await ctx.http().get('/v1/card-feed/me').set(feed()).expect(401);
    await ctx.http().post('/v1/card-feed/transactions').set(feed()).send({ transactions: [{ id: 'late', card: '4242', date: T, amount: '1.00', merchant: 'Late' }] }).expect(401);
  });
});
