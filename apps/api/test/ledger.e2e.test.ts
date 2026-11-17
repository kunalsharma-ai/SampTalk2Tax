import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';
import { randomUUID } from 'node:crypto';
import { runInOrg } from '../src/common/tenant-context';
import { postgresOff } from '../src/db/counters';
import { journalEntries } from '../src/db/collections/ledger';

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  org = await createOrg(ctx, owner);
});
afterAll(async () => {
  await ctx.app.close();
});

const je = (acc: Record<string, string>, debitCode: string, creditCode: string, amount: string, extra: Record<string, unknown> = {}) => ({
  date: today(),
  post: true,
  lines: [
    { accountId: acc[debitCode], debit: amount },
    { accountId: acc[creditCode], credit: amount },
  ],
  ...extra,
});

async function tb(base: string, user: TestUser) {
  return (await ctx.http().get(`${base}/reports/trial-balance?asOf=${today()}`).set(user.auth).expect(200)).body;
}

describe('journal posting', () => {
  it('posts a balanced entry, numbers it, and reflects it in the trial balance', async () => {
    const res = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '500000.00', { memo: 'Capital introduced' })).expect(201);
    expect(res.body.status).toBe('POSTED');
    expect(res.body.entryNumber).toBe(1);
    expect(res.body.displayNumber).toBe('JE-000001');
    const t = await tb(org.base, owner);
    expect(t.balanced).toBe(true);
    expect(t.rows.find((r: { code: string }) => r.code === '1120').balance).toBe('500000.00');
  });

  it('rejects unbalanced, malformed and header-account entries with clear reasons', async () => {
    const unbalanced = await ctx
      .http()
      .post(`${org.base}/journals`)
      .set(owner.auth)
      .send({ date: today(), post: true, lines: [{ accountId: org.acc['1120'], debit: '100.00' }, { accountId: org.acc['4100'], credit: '99.00' }] })
      .expect(422);
    expect(unbalanced.body.error).toBe('JOURNAL_INVALID');
    expect(unbalanced.body.issues.join()).toMatch(/does not balance/);

    // JSON numbers are refused: amounts must be decimal strings.
    await ctx
      .http()
      .post(`${org.base}/journals`)
      .set(owner.auth)
      .send({ date: today(), lines: [{ accountId: org.acc['1120'], debit: 0.1 }, { accountId: org.acc['4100'], credit: 0.1 }] })
      .expect(400);

    const header = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1000', '4100', '5.00')).expect(422);
    expect(header.body.issues.join()).toMatch(/header account/);

    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '4100', '1.001')).expect(422);
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ ...je(org.acc, '1120', '4100', '5.00'), date: '1999-01-01' }).expect(422);
  });

  it('keeps drafts out of balances until posted, and allows editing and deleting drafts only', async () => {
    const before = await tb(org.base, owner);
    const draft = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ ...je(org.acc, '6200', '2200', '25000.00'), post: false }).expect(201);
    expect(draft.body.entryNumber).toBeNull();
    expect((await tb(org.base, owner)).totals.debit).toBe(before.totals.debit);

    const edited = await ctx
      .http()
      .put(`${org.base}/journals/${draft.body.id}`)
      .set(owner.auth)
      .send({ date: today(), memo: 'Office rent', lines: [{ accountId: org.acc['6200'], debit: '30000.00' }, { accountId: org.acc['2200'], credit: '30000.00' }] })
      .expect(200);
    expect(edited.body.totalDebit).toBe('30000.00');

    const posted = await ctx.http().post(`${org.base}/journals/${draft.body.id}/post`).set(owner.auth).expect(200);
    expect(posted.body.status).toBe('POSTED');
    await ctx.http().post(`${org.base}/journals/${draft.body.id}/post`).set(owner.auth).expect(409);
    await ctx.http().put(`${org.base}/journals/${draft.body.id}`).set(owner.auth).send({ date: today(), lines: edited.body.lines.map((l: { accountId: string; debit: string; credit: string }) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })) }).expect(409);
    await ctx.http().delete(`${org.base}/journals/${draft.body.id}`).set(owner.auth).expect(409);

    const another = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ ...je(org.acc, '6300', '1120', '10.00'), post: false }).expect(201);
    await ctx.http().delete(`${org.base}/journals/${another.body.id}`).set(owner.auth).expect(204);
    await ctx.http().get(`${org.base}/journals/${another.body.id}`).set(owner.auth).expect(404);
  });

  it('converts foreign-currency lines to the functional currency', async () => {
    const res = await ctx
      .http()
      .post(`${org.base}/journals`)
      .set(owner.auth)
      .send({
        date: today(),
        post: true,
        memo: 'Prepaid annual licence billed in USD',
        lines: [
          { accountId: org.acc['1400'], debit: '1000.00', currency: 'USD', exchangeRate: '83.4567' },
          { accountId: org.acc['4100'], credit: '83456.70' },
        ],
      })
      .expect(201);
    expect(res.body.lines[0]).toMatchObject({ currency: 'USD', debit: '1000.00', functionalDebit: '83456.70' });
  });
});

describe('immutability and reversal', () => {
  it('blocks any direct change to posted entries at the database level', async () => {
    const res = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '6400', '1120', '999.00')).expect(201);
    const id = res.body.id;
    await expect(sqlWrite(ctx, `UPDATE journal_lines SET debit = 1, functional_debit = 1 WHERE entry_id = '${id}' AND line_no = 1`)).rejects.toThrow(/immutable/);
    await expect(sqlWrite(ctx, `UPDATE journal_entries SET memo = 'tampered' WHERE id = '${id}'`)).rejects.toThrow(/immutable/);
    await expect(sqlWrite(ctx, `DELETE FROM journal_lines WHERE entry_id = '${id}'`)).rejects.toThrow(/immutable/);
    await expect(sqlWrite(ctx, `DELETE FROM journal_entries WHERE id = '${id}'`)).rejects.toThrow(/cannot be deleted/);
  });

  it('refuses an unbalanced posted entry even if inserted directly in SQL', async () => {
    const period = await ctx.prisma.fiscalPeriod.findFirstOrThrow({ where: { orgId: org.orgId, status: 'OPEN', startDate: { lte: new Date(today()) }, endDate: { gte: new Date(today()) } } });
    if (postgresOff()) {
      // Written straight to the ledger's collection: the store's guard refuses it.
      const line = (lineNo: number, accountId: string, debit: string, credit: string) => ({
        id: randomUUID(), lineNo, accountId, currency: 'INR', exchangeRate: '1', debit, credit, functionalDebit: debit, functionalCredit: credit, description: null, dimensions: null, departmentId: null, projectId: null,
      });
      const now = new Date();
      const entry = {
        entryNumber: 999999, date: new Date(today()), periodId: period.id, type: 'STANDARD', source: 'MANUAL', status: 'POSTED', memo: null, reference: null, functionalCurrency: 'INR', totalDebit: '10', totalCredit: '10',
        idempotencyKey: null, idempotencyHash: null, reversesEntryId: null, createdById: owner.id, postedById: owner.id, postedAt: now, createdAt: now, updatedAt: now,
        lines: [line(1, org.acc['1120'], '10', '0'), line(2, org.acc['4100'], '0', '9')],
      };
      await expect(runInOrg(org.orgId, () => ctx.store.collection(journalEntries).insertOne(entry as never))).rejects.toThrow(/does not balance/);
      return;
    }
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        const e = await tx.journalEntry.create({
          data: { orgId: org.orgId, date: new Date(today()), periodId: period.id, functionalCurrency: 'INR', createdById: owner.id, totalDebit: '10', totalCredit: '10' },
        });
        await tx.journalLine.createMany({
          data: [
            { orgId: org.orgId, entryId: e.id, lineNo: 1, accountId: org.acc['1120'], currency: 'INR', exchangeRate: '1', debit: '10', functionalDebit: '10' },
            { orgId: org.orgId, entryId: e.id, lineNo: 2, accountId: org.acc['4100'], currency: 'INR', exchangeRate: '1', credit: '9', functionalCredit: '9' },
          ],
        });
        await tx.journalEntry.update({ where: { id: e.id }, data: { status: 'POSTED', entryNumber: 999999, postedAt: new Date(), postedById: owner.id } });
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('reverses a posted entry exactly once and nets it to zero', async () => {
    const before = await tb(org.base, owner);
    const original = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '6500', '1120', '4321.09')).expect(201);
    const reversal = await ctx.http().post(`${org.base}/journals/${original.body.id}/reverse`).set(owner.auth).send({ date: today() }).expect(201);
    expect(reversal.body.type).toBe('REVERSING');
    expect(reversal.body.reversesEntryId).toBe(original.body.id);
    expect(reversal.body.lines[0]).toMatchObject({ accountId: org.acc['6500'], credit: '4321.09' });

    const after = await tb(org.base, owner);
    const bal = (t: { rows: { code: string; balance: string }[] }, code: string) => t.rows.find((r) => r.code === code)?.balance ?? '0.00';
    expect(bal(after, '6500')).toBe(bal(before, '6500'));
    expect(bal(after, '1120')).toBe(bal(before, '1120'));

    await ctx.http().post(`${org.base}/journals/${original.body.id}/reverse`).set(owner.auth).send({ date: today() }).expect(409);
    await ctx.http().post(`${org.base}/journals/${reversal.body.id}/reverse`).set(owner.auth).send({ date: today() }).expect(409);
    const fetched = await ctx.http().get(`${org.base}/journals/${original.body.id}`).set(owner.auth).expect(200);
    expect(fetched.body.reversedBy.id).toBe(reversal.body.id);
  });

  it('allows only one of many concurrent reversals', async () => {
    const original = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '6600', '1120', '100.00')).expect(201);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ctx.http().post(`${org.base}/journals/${original.body.id}/reverse`).set(owner.auth).send({ date: today() })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });
});

describe('idempotency and concurrency', () => {
  it('returns the original entry when a request is retried with the same Idempotency-Key', async () => {
    const body = je(org.acc, '6700', '1120', '250.00');
    const first = await ctx.http().post(`${org.base}/journals`).set(owner.auth).set('Idempotency-Key', 'travel-claim-0001').send(body).expect(201);
    const retry = await ctx.http().post(`${org.base}/journals`).set(owner.auth).set('Idempotency-Key', 'travel-claim-0001').send(body).expect(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    const misuse = await ctx.http().post(`${org.base}/journals`).set(owner.auth).set('Idempotency-Key', 'travel-claim-0001').send(je(org.acc, '6700', '1120', '999.00')).expect(422);
    expect(misuse.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('creates exactly one entry from concurrent retries with one key', async () => {
    const body = je(org.acc, '6900', '1120', '12.34');
    const results = await Promise.all(Array.from({ length: 8 }, () => ctx.http().post(`${org.base}/journals`).set(owner.auth).set('Idempotency-Key', 'bank-fee-concurrent-01').send(body)));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  });

  it('assigns gap-free unique numbers under concurrent posting', async () => {
    const fresh = await createOrg(ctx, owner, { name: 'Concurrency Co' });
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => ctx.http().post(`${fresh.base}/journals`).set(owner.auth).send(je(fresh.acc, '1110', '3100', `${i + 1}.00`))));
    expect(results.map((r) => r.status)).toEqual(Array(25).fill(201));
    const numbers = results.map((r) => r.body.entryNumber as number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const t = await tb(fresh.base, owner);
    expect(t.balanced).toBe(true);
    expect(t.rows.find((r: { code: string }) => r.code === '1110').balance).toBe('325.00');
  });
});

describe('period locks', () => {
  it('blocks posting into a locked period and allows it again after unlock', async () => {
    const fresh = await createOrg(ctx, owner, { name: 'Lock Co' });
    const periods = (await ctx.http().get(`${fresh.base}/periods`).set(owner.auth).expect(200)).body as { id: string; startDate: string; endDate: string }[];
    const current = periods.find((p) => p.startDate <= today() && today() <= p.endDate)!;
    const draft = await ctx.http().post(`${fresh.base}/journals`).set(owner.auth).send({ ...je(fresh.acc, '1110', '3100', '1.00'), post: false }).expect(201);

    await ctx.http().post(`${fresh.base}/periods/${current.id}/lock`).set(owner.auth).expect(200);
    const blocked = await ctx.http().post(`${fresh.base}/journals`).set(owner.auth).send(je(fresh.acc, '1110', '3100', '1.00')).expect(409);
    expect(blocked.body.error).toBe('PERIOD_NOT_OPEN');
    await ctx.http().post(`${fresh.base}/journals/${draft.body.id}/post`).set(owner.auth).expect(409);

    await ctx.http().post(`${fresh.base}/periods/${current.id}/unlock`).set(owner.auth).expect(200);
    await ctx.http().post(`${fresh.base}/journals`).set(owner.auth).send(je(fresh.acc, '1110', '3100', '1.00')).expect(201);
    await ctx.http().post(`${fresh.base}/journals/${draft.body.id}/post`).set(owner.auth).expect(200);
  });

  it('creates further fiscal years on request and refuses duplicates', async () => {
    const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { fiscalYear: number }[];
    const next = periods[0].fiscalYear + 1;
    const created = await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: next }).expect(201);
    expect(created.body).toHaveLength(12);
    await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: next }).expect(409);
  });
});

describe('chart of accounts rules', () => {
  it('protects accounts that have postings', async () => {
    await ctx.http().patch(`${org.base}/accounts/${org.acc['1120']}`).set(owner.auth).send({ code: '1121' }).expect(409);
    await ctx.http().patch(`${org.base}/accounts/${org.acc['1120']}`).set(owner.auth).send({ isActive: false }).expect(409);
    await ctx.http().patch(`${org.base}/accounts/${org.acc['1120']}`).set(owner.auth).send({ isPostable: false }).expect(409);
    await ctx.http().patch(`${org.base}/accounts/${org.acc['1120']}`).set(owner.auth).send({ name: 'Main Bank (HDFC)' }).expect(200);
  });

  it('validates hierarchy, subtype and uniqueness', async () => {
    await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1130', name: 'Petty', type: 'ASSET', subtype: 'CASH', parentId: org.acc['1100'] }).expect(201);
    await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1130', name: 'Dup', type: 'ASSET' }).expect(409);
    await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1140', name: 'Bad parent', type: 'ASSET', parentId: org.acc['2000'] }).expect(422);
    await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1150', name: 'Bad subtype', type: 'ASSET', subtype: 'ACCOUNTS_PAYABLE' }).expect(422);
    await ctx.http().patch(`${org.base}/accounts/${org.acc['1000']}`).set(owner.auth).send({ parentId: org.acc['1100'] }).expect(422);
  });
});

describe('financial reports', () => {
  it('produce a balanced trial balance and statements that tie out', async () => {
    const t = await tb(org.base, owner);
    expect(t.balanced).toBe(true);
    expect(t.totals.netDebit).toBe(t.totals.netCredit);

    const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { startDate: string; endDate: string }[];
    const fyStart = periods[0].startDate;
    const is = (await ctx.http().get(`${org.base}/reports/income-statement?from=${fyStart}&to=${today()}`).set(owner.auth).expect(200)).body;
    const bs = (await ctx.http().get(`${org.base}/reports/balance-sheet?asOf=${today()}`).set(owner.auth).expect(200)).body;
    expect(bs.balanced).toBe(true);
    expect(bs.unclosedEarnings).toBe(is.netIncome);
    const sum = (xs: { amount: string }[]) => xs.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0);
    expect(sum(bs.assets)).toBe(sum(bs.liabilities) + sum(bs.equity) + Math.round(Number(bs.unclosedEarnings) * 100));
  });

  it('builds an account ledger with opening and running balances', async () => {
    const res = await ctx.http().get(`${org.base}/reports/general-ledger?accountId=${org.acc['1120']}&from=${today()}&to=${today()}`).set(owner.auth).expect(200);
    expect(res.body.rows.length).toBeGreaterThan(3);
    expect(res.body.closingBalance).toBe(res.body.rows[res.body.rows.length - 1].runningBalance);
    const t = await tb(org.base, owner);
    expect(res.body.closingBalance).toBe(t.rows.find((r: { code: string }) => r.code === '1120').balance);
  });
});

describe('dashboard', () => {
  it('summarises balances and year-to-date figures consistently with the statements', async () => {
    const d = (await ctx.http().get(`${org.base}/reports/dashboard?asOf=${today()}`).set(owner.auth).expect(200)).body;
    const t = await tb(org.base, owner);
    const bal = (code: string) => t.rows.find((r: { code: string }) => r.code === code)?.balance ?? '0.00';
    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(cents(d.balances.cash)).toBe(cents(bal('1110')) + cents(bal('1120')));
    expect(d.balances.receivables).toBe(bal('1200'));
    expect(d.balances.payables).toBe(bal('2100'));
    const is = (await ctx.http().get(`${org.base}/reports/income-statement?from=${d.fiscalYearStart}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(d.yearToDate.netIncome).toBe(is.netIncome);
    expect(d.periods[d.periods.length - 1].closingCash).toBe(d.balances.cash);
    expect(cents(d.yearToDate.revenue)).toBe(d.periods.reduce((s: number, p: { revenue: string }) => s + cents(p.revenue), 0));
  });
});

describe('audit trail', () => {
  it('records actions in a verifiable hash chain that cannot be altered', async () => {
    const events = await ctx.http().get(`${org.base}/audit-events?limit=500`).set(owner.auth).expect(200);
    const actions = new Set(events.body.map((e: { action: string }) => e.action));
    for (const a of ['organization.created', 'journal.created_and_posted', 'journal.reversed', 'period.locked', 'account.updated']) {
      if (a === 'period.locked') continue; // locked in a different org above
      expect(actions.has(a)).toBe(true);
    }
    const verify = await ctx.http().get(`${org.base}/audit-events/verify`).set(owner.auth).expect(200);
    expect(verify.body.valid).toBe(true);
    expect(verify.body.checked).toBe(events.body.length);
    await expect(sqlWrite(ctx, `UPDATE audit_events SET action = 'x' WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/append-only/);
    await expect(sqlWrite(ctx, `DELETE FROM audit_events WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/append-only/);
  });
});
