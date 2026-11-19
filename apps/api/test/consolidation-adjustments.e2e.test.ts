import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Consolidation adjustments (GL-034) against the real API and database: goodwill on acquisition
 * and unrealised profit entered in the consolidation only, checked before they are recorded,
 * shown in the worksheet's adjustments column, carried forward when dated before the period,
 * voided once with a reason, audited, and never changed afterwards.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let parent: Org;
let sub: Org;
let G: string;
let groupId: string;
const T = today();
const FROM = `${Number(T.slice(5, 7)) >= 4 ? T.slice(0, 4) : Number(T.slice(0, 4)) - 1}-04-01`;
const BEFORE = `${Number(FROM.slice(0, 4)) - 1}-12-31`;

const account = async (o: Org, code: string, name: string, type: string) => {
  o.acc[code] = (await ctx.http().post(`${o.base}/accounts`).set(owner.auth).send({ code, name, type }).expect(201)).body.id;
};
const journal = (o: Org, debit: string, credit: string, amount: string, memo: string) =>
  ctx.http().post(`${o.base}/journals`).set(owner.auth).send({ date: T, post: true, memo, lines: [{ accountId: o.acc[debit], debit: amount }, { accountId: o.acc[credit], credit: amount }] }).expect(201);
const report = async () => (await ctx.http().get(`${G}/${groupId}/report?from=${FROM}&to=${T}`).set(owner.auth).expect(200)).body;
type WRow = { kind: string; code: string; amounts: string[]; elimination: string; adjustment: string; consolidated: string };
const row = (r: { rows: WRow[] }, code: string) => r.rows.find((x) => x.code === code);
const line = (code: string, name: string, type: string, debit: string, credit: string) => ({ code, name, type, debit, credit });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Adjusting Owner');
  accountant = await registerUser(ctx, 'Adjusting Accountant');
  parent = await createOrg(ctx, owner, { name: 'Adj Holding Ltd' });
  sub = await createOrg(ctx, owner, { name: 'Adj Sub Pvt Ltd' });
  await ctx.http().post(`${parent.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  G = `${parent.base}/consolidation/groups`;
  await account(parent, '1600', 'Investment in subsidiaries', 'ASSET');
  await journal(parent, '1120', '3100', '500000.00', 'Capital');
  await journal(parent, '1600', '1120', '200000.00', 'Buy Sub');
  await journal(sub, '1120', '3100', '150000.00', 'Capital');
  groupId = (await ctx.http().post(G).set(owner.auth).send({ name: 'Adjusted group' }).expect(201)).body.id;
  await ctx.http().post(`${G}/${groupId}/members`).set(owner.auth).send({ orgId: sub.orgId }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('consolidation adjustments', () => {
  let goodwill: string;

  it('are checked before they are recorded, by someone who manages the organisation', async () => {
    const body = { date: T, description: 'Goodwill on acquisition of Sub', lines: [line('1900', 'Goodwill', 'ASSET', '50000', ''), line('3100', 'Share capital', 'EQUITY', '150000', ''), line('1600', 'Investment in subsidiaries', 'ASSET', '', '200000')] };
    await ctx.http().post(`${G}/${groupId}/adjustments`).set(accountant.auth).send(body).expect(403);
    const bad = (await ctx.http().post(`${G}/${groupId}/adjustments`).set(owner.auth).send({ ...body, lines: [body.lines[0], { ...body.lines[2], credit: '40000' }] }).expect(422)).body;
    expect(bad.error).toBe('ADJUSTMENT_INVALID');
    expect(bad.details.issues).toEqual(['Debits (50000.00) and credits (40000.00) must be equal']);
    await ctx.http().post(`${G}/${groupId}/adjustments`).set(owner.auth).send({ ...body, description: ' ' }).expect(422);
    const a = (await ctx.http().post(`${G}/${groupId}/adjustments`).set(owner.auth).send(body).expect(201)).body;
    expect(a).toMatchObject({ reference: 'CA-0001', status: 'POSTED', total: '200000', date: T });
    expect(a.lines[0]).toMatchObject({ code: '1900', debit: '50000.00', credit: '0.00' });
    goodwill = a.id;
  });

  it('change only the consolidation: goodwill is added and the investment and capital go', async () => {
    const r = await report();
    expect(r.balanced).toBe(true);
    expect(row(r, '1900')).toMatchObject({ amounts: ['0.00', '0.00'], adjustment: '50000.00', consolidated: '50000.00' });
    expect(row(r, '1600')).toMatchObject({ amounts: ['200000.00', '0.00'], adjustment: '-200000.00', consolidated: '0.00' });
    expect(row(r, '3100')).toMatchObject({ adjustment: '150000.00', consolidated: '-500000.00' });
    expect(r.adjustments).toEqual([expect.objectContaining({ name: 'CA-0001 Goodwill on acquisition of Sub' })]);
    expect(r.balanceSheet).toMatchObject({ totalAssets: '500000.00', balanced: true });
    // Neither company's own trial balance has goodwill.
    const tb = (await ctx.http().get(`${parent.base}/reports/trial-balance?asOf=${T}`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(tb)).not.toContain('Goodwill');
    const csv = (await ctx.http().get(`${G}/${groupId}/export/worksheet?from=${FROM}&to=${T}&format=csv`).set(owner.auth).expect(200)).text;
    expect(csv).toContain('Eliminations,Adjustments,Consolidated');
    expect(csv).toContain('1900,Goodwill,0.00,0.00,0.00,50000.00,50000.00');
    expect(csv).toContain('Adjustment CA-0001 Goodwill on acquisition of Sub:');
  });

  it('take profit and loss lines dated before the period to earnings brought forward', async () => {
    await ctx.http().post(`${G}/${groupId}/adjustments`).set(owner.auth).send({ date: BEFORE, description: 'Prior year fee accrual', lines: [line('6100', 'Salaries', 'EXPENSE', '1000', ''), line('2190', 'Accrued fees', 'LIABILITY', '', '1000')] }).expect(201);
    const r = await report();
    expect(r.rows.find((x: WRow) => x.kind === 'EARNINGS_BROUGHT_FORWARD')).toMatchObject({ adjustment: '1000.00' });
    expect(row(r, '2190')).toMatchObject({ adjustment: '-1000.00' });
    expect(r.incomeStatement.totalExpenses).toBe('0.00');
    expect(r.balanced).toBe(true);
    expect(r.balanceSheet.balanced).toBe(true);
  });

  it('refuse a line whose type differs from the companies\' account', async () => {
    const a = (await ctx.http().post(`${G}/${groupId}/adjustments`).set(owner.auth).send({ date: T, description: 'Wrong type', lines: [line('1120', 'Bank', 'EXPENSE', '10', ''), line('1600', 'Investment', 'ASSET', '', '10')] }).expect(201)).body;
    const res = (await ctx.http().get(`${G}/${groupId}/report?from=${FROM}&to=${T}`).set(owner.auth).expect(422)).body;
    expect(res.details.issues).toEqual([expect.stringContaining('account 1120 is asset in the companies\' books, not expense')]);
    await ctx.http().post(`${G}/${groupId}/adjustments/${a.id}/void`).set(owner.auth).send({ reason: 'x' }).expect(422);
    const v = (await ctx.http().post(`${G}/${groupId}/adjustments/${a.id}/void`).set(owner.auth).send({ reason: 'Entered with the wrong type' }).expect(200)).body;
    expect(v).toMatchObject({ status: 'VOID', voidReason: 'Entered with the wrong type' });
    await ctx.http().post(`${G}/${groupId}/adjustments/${a.id}/void`).set(owner.auth).send({ reason: 'Again please' }).expect(409);
    expect((await report()).balanced).toBe(true);
  });

  it('are listed, audited, never changed, and keep the group from being deleted', async () => {
    const list = (await ctx.http().get(`${G}/${groupId}/adjustments`).set(accountant.auth).expect(200)).body;
    expect(list.map((a: { reference: string; status: string }) => `${a.reference} ${a.status}`)).toEqual(['CA-0003 VOID', 'CA-0002 POSTED', 'CA-0001 POSTED']);
    const audit = (await ctx.http().get(`${parent.base}/audit-events?entityType=consolidation_adjustment&limit=100`).set(owner.auth).expect(200)).body;
    const actions = (Array.isArray(audit) ? audit : audit.items).map((e: { action: string }) => e.action);
    expect(actions.filter((x: string) => x === 'consolidation_adjustment.posted')).toHaveLength(3);
    expect(actions).toContain('consolidation_adjustment.voided');
    expect((await ctx.http().delete(`${G}/${groupId}`).set(owner.auth).expect(409)).body.error).toBe('GROUP_IN_USE');
    const db = ctx.app.get((await import('../src/common/prisma.service')).PrismaService);
    await expect(db.consolidationAdjustment.update({ where: { id: goodwill }, data: { description: 'Changed' } })).rejects.toThrow();
    await expect(db.consolidationAdjustment.delete({ where: { id: goodwill } })).rejects.toThrow();
  });
});
