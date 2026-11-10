import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInOrg } from '../src/common/tenant-context';
import { accounts, fiscalPeriods } from '../src/db/collections/chart';
import { bootApp, createOrg, Ctx, registerUser, today } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await bootApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;

describe('the chart of accounts and fiscal periods live in MongoDB', () => {
  it('a new organisation gets its chart and fiscal year in MongoDB, copied to PostgreSQL', async () => {
    const owner = await registerUser(ctx, 'Chart Owner');
    const { orgId, acc } = await createOrg(ctx, owner, { chartTemplate: 'GENERIC_SMB' });
    const inMongo = await ctx.db.collection('accounts').countDocuments({ orgId });
    expect(inMongo).toBeGreaterThan(20);
    expect(await ctx.prisma.account.count({ where: { orgId } })).toBe(inMongo);
    const periods = await ctx.db.collection('fiscal_periods').countDocuments({ orgId });
    expect(periods).toBe(12);
    expect(await ctx.prisma.fiscalPeriod.count({ where: { orgId } })).toBe(12);
    const org = await ctx.db.collection('organizations').findOne({ _id: orgId as never });
    expect(org?.arAccountId).toBe(acc['1200']);
    expect(await ctx.prisma.organization.findUnique({ where: { id: orgId }, select: { arAccountId: true } })).toEqual({ arAccountId: acc['1200'] });
  });

  it('account changes go to MongoDB first and the copy follows', async () => {
    const owner = await registerUser(ctx, 'Chart Editor');
    const { orgId, acc, base } = await createOrg(ctx, owner, { chartTemplate: 'GENERIC_SMB' });
    const created = await ctx.http().post(`${base}/accounts`).set(owner.auth).send({ code: '6555', name: 'Software', type: 'EXPENSE', parentId: acc['6000'] }).expect(201);
    expect(await ctx.db.collection('accounts').findOne({ _id: created.body.id })).toMatchObject({ code: '6555', parentId: acc['6000'], isActive: true });
    await ctx.http().patch(`${base}/accounts/${created.body.id}`).set(owner.auth).send({ name: 'Software subscriptions' }).expect(200);
    expect(await ctx.prisma.account.findUnique({ where: { id: created.body.id }, select: { name: true } })).toEqual({ name: 'Software subscriptions' });
    // The same code twice is refused by the unique index.
    await ctx.http().post(`${base}/accounts`).set(owner.auth).send({ code: '6555', name: 'Again', type: 'EXPENSE' }).expect(409);
    expect(await ctx.db.collection('accounts').countDocuments({ orgId, code: '6555' })).toBe(1);
  });

  it('the data layer keeps the rules PostgreSQL kept', async () => {
    const owner = await registerUser(ctx, 'Rule Keeper');
    const a = await createOrg(ctx, owner, { chartTemplate: 'GENERIC_SMB' });
    const b = await createOrg(ctx, owner, { chartTemplate: 'GENERIC_SMB', name: 'Other Co' });
    const now = new Date();
    // A parent from another organisation is refused.
    await expect(runInOrg(a.orgId, () => ctx.store.collection(accounts).insertOne({ code: '9991', name: 'X', type: 'EXPENSE', subtype: null, description: null, parentId: b.acc['6000'], isPostable: true, isActive: true, createdAt: now, updatedAt: now }))).rejects.toThrow(/parent/i);
    // An account keeps its type.
    await expect(runInOrg(a.orgId, () => ctx.store.collection(accounts).updateOne({ id: a.acc['6000'] }, { $set: { type: 'ASSET' } }))).rejects.toThrow(/type/i);

    const periods = await ctx.db.collection('fiscal_periods').find({ orgId: a.orgId }).sort({ startDate: 1 }).toArray();
    const first = periods[0]!;
    // Overlapping periods are refused (was an exclusion constraint).
    await expect(
      runInOrg(a.orgId, () => ctx.store.collection(fiscalPeriods).insertOne({ fiscalYear: 1999, periodNo: 1, name: 'Overlap', startDate: first.startDate, endDate: first.endDate, status: 'OPEN', lockedAt: null, lockedById: null })),
    ).rejects.toThrow(/overlaps/);
    // A period's dates cannot change.
    await expect(runInOrg(a.orgId, () => ctx.store.collection(fiscalPeriods).updateOne({ id: first._id as unknown as string }, { $set: { endDate: new Date('2999-01-01') } }))).rejects.toThrow(/dates/);
  });

  it('two requests adding the same fiscal year: one wins, with twelve periods', async () => {
    const owner = await registerUser(ctx, 'Year Adder');
    const { orgId, base } = await createOrg(ctx, owner);
    const fy = Number(today().slice(0, 4)) + 3;
    const send = () => ctx.http().post(`${base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ctx.db.collection('fiscal_periods').countDocuments({ orgId, fiscalYear: fy })).toBe(12);
    expect(await ctx.prisma.fiscalPeriod.count({ where: { orgId, fiscalYear: fy } })).toBe(12);
  });

  it('locking a period changes MongoDB and the copy that postings check', async () => {
    const owner = await registerUser(ctx, 'Locker');
    const { orgId, base } = await createOrg(ctx, owner);
    const [p] = (await ctx.http().get(`${base}/periods`).set(owner.auth).expect(200)).body as { id: string }[];
    await ctx.http().post(`${base}/periods/${p!.id}/lock`).set(owner.auth).expect(200);
    expect(await ctx.db.collection('fiscal_periods').findOne({ _id: p!.id as never })).toMatchObject({ status: 'LOCKED', lockedById: owner.id });
    expect(await ctx.prisma.fiscalPeriod.findUnique({ where: { id: p!.id }, select: { status: true } })).toEqual({ status: 'LOCKED' });
    await ctx.http().post(`${base}/periods/${p!.id}/lock`).set(owner.auth).expect(409);
    await ctx.http().post(`${base}/periods/${p!.id}/unlock`).set(owner.auth).expect(200);
    expect(await ctx.prisma.fiscalPeriod.findUnique({ where: { id: p!.id }, select: { status: true, lockedAt: true } })).toEqual({ status: 'OPEN', lockedAt: null });
    expect(orgId).toBeTruthy();
  });

  it('an account left in MongoDB without its copy is copied when set-up runs again', async () => {
    const owner = await registerUser(ctx, 'GST Setup');
    const { orgId, base } = await createOrg(ctx, owner, { chartTemplate: 'GENERIC_SMB' });
    // As if an earlier GST set-up made Output CGST and was then rolled back in PostgreSQL.
    const now = new Date();
    const orphan = await runInOrg(orgId, () => ctx.store.collection(accounts).insertOne({ code: '2310', name: 'Output CGST', type: 'LIABILITY', subtype: 'TAX_PAYABLE', description: null, parentId: null, isPostable: true, isActive: true, createdAt: now, updatedAt: now }));
    expect(await ctx.prisma.account.findUnique({ where: { id: orphan.id } })).toBeNull();
    await ctx.http().put(`${base}/gst/registration`).set(owner.auth).send({ gstin: gstin('27', 'ZZZCH0001Z'), effectiveFrom: today() }).expect(200);
    expect(await ctx.prisma.account.findUnique({ where: { id: orphan.id }, select: { code: true } })).toEqual({ code: '2310' });
    expect(await ctx.prisma.auditEvent.count({ where: { orgId, action: 'account.created', entityId: orphan.id } })).toBe(1);
    expect(await ctx.db.collection('accounts').countDocuments({ orgId, code: { $in: ['2310', '2311', '2312', '1451', '1452', '1453'] } })).toBe(6);
  });
});
