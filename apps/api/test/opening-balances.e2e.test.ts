import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Opening balances (GL-010) and the journal types around them (GL-008): balances are posted as
 * one OPENING journal, the difference goes to Opening Balance Equity, saving again replaces the
 * journal by reversing it in the same transaction, and control accounts, locked periods and
 * people without posting rights are refused. Real API and database.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let fyStart: string;
type Row = { code: string; netDebit: string; netCredit: string };
const tbRow = async (code: string) => {
  const t = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${today()}`).set(owner.auth).expect(200)).body as { rows: Row[]; balanced: boolean };
  expect(t.balanced).toBe(true);
  const r = t.rows.find((x) => x.code === code);
  return r ? { dr: r.netDebit, cr: r.netCredit } : null;
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Opening Owner');
  viewer = await registerUser(ctx, 'Opening Viewer');
  org = await createOrg(ctx, owner, { name: 'Opening Test Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { startDate: string }[];
  fyStart = periods.map((p) => p.startDate).sort()[0];
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('opening balances (GL-010)', () => {
  it('starts empty, offering postable accounts but not the receivables and payables control accounts', async () => {
    const r = (await ctx.http().get(`${org.base}/opening-balances`).set(viewer.auth).expect(200)).body;
    expect(r.current).toBeNull();
    expect(r.offsetAccount).toBeNull();
    expect(r.currency).toBe('INR');
    const codes = (r.accounts as { code: string }[]).map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['1110', '1120', '1510', '3100']));
    expect(codes).not.toContain('1200');
    expect(codes).not.toContain('1000');
  });

  it('posts the balances as one OPENING journal, with the difference in Opening Balance Equity', async () => {
    const r = (
      await ctx
        .http()
        .put(`${org.base}/opening-balances`)
        .set(owner.auth)
        .send({ date: fyStart, lines: [{ accountId: org.acc['1120'], debit: '250000' }, { accountId: org.acc['1510'], debit: '800000.00' }, { accountId: org.acc['3100'], credit: '1000000' }, { accountId: org.acc['1110'], debit: '' }] })
        .expect(200)
    ).body;
    expect(r.offsetAccount).toMatchObject({ code: '3250', name: 'Opening Balance Equity' });
    expect(r.current.date).toBe(fyStart);
    expect(r.current.balances.map((b: { accountCode: string; debit: string; credit: string }) => [b.accountCode, b.debit, b.credit])).toEqual([
      ['1120', '250000.00', '0.00'],
      ['1510', '800000.00', '0.00'],
      ['3100', '0.00', '1000000.00'],
    ]);
    expect(r.current.difference).toEqual({ debit: '0.00', credit: '50000.00' });
    expect(r.warnings).toEqual([]);
    const j = (await ctx.http().get(`${org.base}/journals/${r.current.journalId}`).set(owner.auth).expect(200)).body;
    expect(j).toMatchObject({ type: 'OPENING', status: 'POSTED', reference: 'OPENING-BALANCES', totalDebit: '1050000.00' });
    expect(await tbRow('3250')).toEqual({ dr: '0.00', cr: '50000.00' });
    expect(await tbRow('1120')).toEqual({ dr: '250000.00', cr: '0.00' });
    // The equity account was added to the chart under Equity.
    const acc = (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; parentId: string | null; subtype: string }[];
    expect(acc.find((a) => a.code === '3250')).toMatchObject({ parentId: org.acc['3000'], subtype: 'OTHER_EQUITY' });
  });

  it('replaces the balances by reversing the journal before, so only one set counts', async () => {
    const before = (await ctx.http().get(`${org.base}/opening-balances`).set(owner.auth).expect(200)).body;
    const r = (
      await ctx
        .http()
        .put(`${org.base}/opening-balances`)
        .set(owner.auth)
        .send({ date: fyStart, lines: [{ accountId: org.acc['1120'], debit: '300000' }, { accountId: org.acc['1510'], debit: '700000' }, { accountId: org.acc['3100'], credit: '1000000' }] })
        .expect(200)
    ).body;
    expect(r.current.journalId).not.toBe(before.current.journalId);
    expect(r.current.difference).toBeNull();
    expect(await tbRow('1120')).toEqual({ dr: '300000.00', cr: '0.00' });
    expect(await tbRow('1510')).toEqual({ dr: '700000.00', cr: '0.00' });
    const obe = await tbRow('3250');
    expect(obe === null || (obe.dr === '0.00' && obe.cr === '0.00')).toBe(true);
    const old = (await ctx.http().get(`${org.base}/journals/${before.current.journalId}`).set(owner.auth).expect(200)).body;
    expect(old.reversedBy).not.toBeNull();
    // The journal list filters by type: two opening journals, one reversal.
    const opening = (await ctx.http().get(`${org.base}/journals?type=OPENING`).set(owner.auth).expect(200)).body;
    expect(opening.total).toBe(2);
    const reversing = (await ctx.http().get(`${org.base}/journals?type=REVERSING`).set(owner.auth).expect(200)).body;
    expect(reversing.items.map((e: { reference: string }) => e.reference)).toEqual(['OPENING-BALANCES']);
    const audit = (await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: 'opening_balances.set' }).toArray()) as unknown as { data: { replaced: string | null } }[];
    expect(audit.map((a) => a.data.replaced)).toEqual([null, before.current.journalId]);
  });

  it('refuses control accounts, the equity account itself, and both sides on one line, changing nothing', async () => {
    const current = (await ctx.http().get(`${org.base}/opening-balances`).set(owner.auth).expect(200)).body.current.journalId;
    const offset = (await ctx.http().get(`${org.base}/opening-balances`).set(owner.auth).expect(200)).body.offsetAccount.id;
    const bad = [
      [{ accountId: org.acc['1200'], debit: '5000' }, 'is not an account that can take an opening balance'],
      [{ accountId: offset, credit: '5000' }, 'takes the difference: leave it out'],
      [{ accountId: org.acc['1120'], debit: '5', credit: '5' }, 'enter a debit or a credit, not both'],
      [{ accountId: org.acc['1120'], debit: '1,000' }, 'is not an amount'],
    ] as const;
    for (const [line, message] of bad) {
      const res = await ctx.http().put(`${org.base}/opening-balances`).set(owner.auth).send({ date: fyStart, lines: [line] }).expect(422);
      expect(res.body.error).toBe('INVALID_OPENING_BALANCES');
      expect(res.body.message).toContain(message);
    }
    expect((await ctx.http().get(`${org.base}/opening-balances`).set(owner.auth).expect(200)).body.current.journalId).toBe(current);
  });

  it('warns about balances on the unusual side without refusing them', async () => {
    const r = (await ctx.http().put(`${org.base}/opening-balances`).set(owner.auth).send({ date: fyStart, lines: [{ accountId: org.acc['1120'], debit: '300000' }, { accountId: org.acc['1110'], credit: '2000' }, { accountId: org.acc['3100'], credit: '298000' }] }).expect(200)).body;
    expect(r.warnings).toEqual(['1110 Cash on Hand usually has a debit balance']);
  });

  it('lets only people who may post set them, and not into a locked period', async () => {
    await ctx.http().put(`${org.base}/opening-balances`).set(viewer.auth).send({ date: fyStart, lines: [{ accountId: org.acc['1120'], debit: '1' }] }).expect(403);
    const fresh = await createOrg(ctx, owner, { name: 'Opening Locked Co' });
    const periods = (await ctx.http().get(`${fresh.base}/periods`).set(owner.auth).expect(200)).body as { id: string; startDate: string }[];
    const first = periods.sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    await ctx.http().post(`${fresh.base}/periods/${first.id}/lock`).set(owner.auth).expect(200);
    const res = await ctx.http().put(`${fresh.base}/opening-balances`).set(owner.auth).send({ date: first.startDate, lines: [{ accountId: fresh.acc['1120'], debit: '100' }, { accountId: fresh.acc['3100'], credit: '100' }] }).expect(409);
    expect(res.body.error).toBe('PERIOD_NOT_OPEN');
    expect((await ctx.http().get(`${fresh.base}/opening-balances`).set(owner.auth).expect(200)).body.current).toBeNull();
  });
});
