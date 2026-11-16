import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInOrg } from '../src/common/tenant-context';
import { journalEntries } from '../src/db/collections/ledger';
import { bootApp, createOrg, Ctx, registerUser, today } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await bootApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const je = (acc: Record<string, string>, debit: string, credit: string, amount: string, extra: Record<string, unknown> = {}) => ({
  date: today(),
  post: true,
  lines: [
    { accountId: acc[debit], debit: amount },
    { accountId: acc[credit], credit: amount },
  ],
  ...extra,
});

describe('the ledger lives in MongoDB', () => {
  it('a posted journal is stored in MongoDB with decimal amounts, and copied to PostgreSQL with the same line ids', async () => {
    const owner = await registerUser(ctx, 'Ledger Owner');
    const org = await createOrg(ctx, owner);
    const res = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '1250.50')).expect(201);
    const doc = await ctx.db.collection('journal_entries').findOne({ _id: res.body.id });
    expect(doc?.status).toBe('POSTED');
    expect(doc?.totalDebit?._bsontype).toBe('Decimal128');
    expect(doc?.totalDebit.toString()).toBe('1250.5');
    const copy = await ctx.prisma.journalEntry.findUniqueOrThrow({ where: { id: res.body.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    expect(copy).toMatchObject({ status: 'POSTED', entryNumber: res.body.entryNumber });
    expect(copy.lines.map((l) => l.id)).toEqual((doc!.lines as { id: string }[]).map((l) => l.id));
    // Reports still read the copy.
    const tb = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${today()}`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(tb)).toContain('1250.50');
  });

  it('drafts change in both databases; deleting one removes both', async () => {
    const owner = await registerUser(ctx, 'Draft Keeper');
    const org = await createOrg(ctx, owner);
    const draft = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '6200', '2200', '10.00', { post: false })).expect(201)).body;
    await ctx.http().put(`${org.base}/journals/${draft.id}`).set(owner.auth).send({ date: today(), type: 'STANDARD', lines: je(org.acc, '6200', '2200', '12.00').lines }).expect(200);
    expect((await ctx.prisma.journalEntry.findUniqueOrThrow({ where: { id: draft.id } })).totalDebit.toFixed(2)).toBe('12.00');
    await ctx.http().delete(`${org.base}/journals/${draft.id}`).set(owner.auth).expect((r) => expect([200, 204]).toContain(r.status));
    expect(await ctx.db.collection('journal_entries').countDocuments({ _id: draft.id })).toBe(0);
    expect(await ctx.prisma.journalEntry.count({ where: { id: draft.id } })).toBe(0);
  });

  it('the data layer keeps the rules the PostgreSQL triggers kept', async () => {
    const owner = await registerUser(ctx, 'Rule Ledger');
    const org = await createOrg(ctx, owner);
    const posted = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '100.00')).expect(201)).body;
    const entries = () => ctx.store.collection(journalEntries);
    // Posted entries are immutable and cannot be deleted.
    await expect(runInOrg(org.orgId, () => entries().updateOne({ id: posted.id }, { $set: { memo: 'changed' } }))).rejects.toThrow(/immutable/);
    await expect(runInOrg(org.orgId, () => entries().deleteOne({ id: posted.id }))).rejects.toThrow(/cannot be deleted/);
    const base = (await runInOrg(org.orgId, () => entries().findOne({ id: posted.id })))!;
    const { id: _id, orgId: _org, ...rest } = base;
    const fresh = (lines: typeof base.lines, more: Record<string, unknown> = {}) => ({ ...rest, entryNumber: null, status: 'DRAFT' as const, postedAt: null, postedById: null, reversesEntryId: null, ...more, lines: lines.map((l, i) => ({ ...l, id: `${l.id.slice(0, 30)}${String(i).padStart(6, '0')}` })) });
    // Unbalanced posted entries are refused.
    const unbalanced = base.lines.map((l, i) => (i === 0 ? { ...l, debit: '99.00', functionalDebit: '99.00' } : l));
    await expect(runInOrg(org.orgId, () => entries().insertOne(fresh(unbalanced, { status: 'POSTED', entryNumber: 99999, postedAt: new Date(), postedById: owner.id })))).rejects.toThrow(/balance/);
    // A line with both sides, or negative amounts, is refused even on a draft.
    const twoSided = base.lines.map((l, i) => (i === 0 ? { ...l, credit: '1.00' } : l));
    await expect(runInOrg(org.orgId, () => entries().insertOne(fresh(twoSided)))).rejects.toThrow(/amounts are invalid/);
    // Posting into a locked period is refused.
    await ctx.http().post(`${org.base}/periods/${base.periodId}/lock`).set(owner.auth).expect(200);
    await expect(runInOrg(org.orgId, () => entries().insertOne(fresh(base.lines, { status: 'POSTED', entryNumber: 99998, postedAt: new Date(), postedById: owner.id })))).rejects.toThrow(/LOCKED period/);
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '1.00')).expect(409);
  });

  it('MongoDB work inside a PostgreSQL transaction commits only if PostgreSQL commits', async () => {
    const owner = await registerUser(ctx, 'Bridge');
    const org = await createOrg(ctx, owner);
    const posted = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '7.00', { post: false })).expect(201)).body;
    await expect(
      ctx.prisma.$transaction(async () => {
        await runInOrg(org.orgId, () => ctx.store.collection(journalEntries).updateOne({ id: posted.id }, { $set: { memo: 'inside a failed transaction' } }));
        throw new Error('postgres refused');
      }),
    ).rejects.toThrow('postgres refused');
    expect((await ctx.db.collection('journal_entries').findOne({ _id: posted.id }))?.memo).not.toBe('inside a failed transaction');
    await ctx.prisma.$transaction(() => runInOrg(org.orgId, () => ctx.store.collection(journalEntries).updateOne({ id: posted.id }, { $set: { memo: 'committed' } })));
    expect((await ctx.db.collection('journal_entries').findOne({ _id: posted.id }))?.memo).toBe('committed');
  });
});
