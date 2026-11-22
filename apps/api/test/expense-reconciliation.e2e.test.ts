import { randomUUID } from 'node:crypto';
import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Expense reconciliation (EXP-016) against the real API and database: claims approved, reimbursed
 * and voided on dates in the past; the employee reimbursements account agrees with the claims
 * owed, as of today and as of an earlier date; reimbursements matched on the bank statement, not
 * on it, and after the statement; an entry on the account that no claim made (set up in the
 * database, as the API refuses one); ageing by employee; permissions, validation and isolation.
 */
const T = today();
const d = (n: number) => addDays(T, -n);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let ravi: TestUser;
let asha: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, { id: string; number: string; journalEntryId: string; reimbursementJournalEntryId: string | null }> = {};

const get = (q = '', user = owner, o = org) => ctx.http().get(`${o.base}/expense-reconciliation${q}`).set(user.auth);
async function approved(key: string, who: TestUser, amount: string, on: number) {
  const x = (await ctx.http().post(`${org.base}/expense-claims`).set(who.auth).send({ title: `Trip ${key}`, lines: [{ date: d(on + 1), accountId: org.acc['6600'], merchant: 'Synthetic Travels', amount }] }).expect(201)).body;
  await ctx.http().post(`${org.base}/expense-claims/${x.id}/submit`).set(who.auth).send({}).expect(200);
  c[key] = (await ctx.http().post(`${org.base}/expense-claims/${x.id}/approve`).set(approver.auth).send({ date: d(on) }).expect(200)).body;
}
const reimburse = async (key: string, on: number) => {
  c[key] = (await ctx.http().post(`${org.base}/expense-claims/${c[key]!.id}/reimburse`).set(owner.auth).send({ bankAccountId: org.acc['1120'], date: d(on) }).expect(200)).body;
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Recon Owner');
  approver = await registerUser(ctx, 'Recon Approver');
  ravi = await registerUser(ctx, 'Ravi Field');
  asha = await registerUser(ctx, 'Asha Sales');
  viewer = await registerUser(ctx, 'Recon Viewer');
  outsider = await registerUser(ctx, 'Recon Outsider');
  org = await createOrg(ctx, owner, { name: 'Claims Reconciled Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Claims Ltd' });
  for (const [u, role] of [[approver, 'APPROVER'], [ravi, 'EMPLOYEE'], [asha, 'EMPLOYEE'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await approved('A', asha, '1200.00', 45);
  await approved('B', ravi, '800.00', 10);
  await approved('C', ravi, '500.00', 20);
  await approved('D', asha, '300.00', 15);
  await approved('E', ravi, '250.00', 6);
  await approved('F', ravi, '400.00', 30);
  await reimburse('C', 12);
  await reimburse('D', 8);
  await reimburse('E', 2);
  await ctx.http().post(`${org.base}/expense-claims/${c.F!.id}/void`).set(owner.auth).send({ date: d(25), reason: 'Claimed twice by mistake' }).expect(200);
  // The statement runs to three days ago: C's payment is on it, D's is not.
  const csv = ['Date,Narration,Ref,Amount', `${dmy(d(12))},NEFT DR RAVI FIELD EXPENSES,UTR1,-500.00`, `${dmy(d(3))},SMS CHARGES,,-59.00`].join('\n');
  await ctx.http().post(`${org.base}/banking/accounts/${org.acc['1120']}/imports`).set(owner.auth).send({ fileName: 'hdfc.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }).expect(201);
  const lines = (await ctx.http().get(`${org.base}/banking/accounts/${org.acc['1120']}/lines`).set(owner.auth).expect(200)).body.lines as { id: string; amount: string }[];
  const je = (await ctx.http().get(`${org.base}/journals/${c.C!.reimbursementJournalEntryId}`).set(owner.auth).expect(200)).body;
  const bankLine = je.lines.find((l: { accountId: string }) => l.accountId === org.acc['1120']);
  await ctx.http().post(`${org.base}/banking/lines/${lines.find((l) => l.amount === '-500.00')!.id}/match`).set(owner.auth).send({ journalLineIds: [bankLine.id] }).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('expense reconciliation', () => {
  it('agrees the employee reimbursements account with the claims owed', async () => {
    const r = (await get().expect(200)).body;
    expect(r).toMatchObject({ asOf: T, currency: 'INR', account: { code: '2250', name: 'Employee Reimbursements Payable' }, ledger: '2000.00', claims: '2000.00', difference: '0.00', reconciled: true, items: [] });
    expect(r.owed.map((o: any) => [o.number, o.claimant, o.amount, o.days, o.overdue])).toEqual([
      [c.A!.number, 'Asha Sales', '1200.00', 45, true],
      [c.B!.number, 'Ravi Field', '800.00', 10, false],
    ]);
    expect(r.ages.map((a: any) => [a.label, a.claims, a.amount])).toEqual([['0 to 15 days', 1, '800.00'], ['16 to 30 days', 0, '0.00'], ['31 to 60 days', 1, '1200.00'], ['Over 60 days', 0, '0.00']]);
    expect(r.employees).toEqual([
      { claimantId: asha.id, claimant: 'Asha Sales', claims: 1, amount: '1200.00', oldestDays: 45, overdue: '1200.00' },
      { claimantId: ravi.id, claimant: 'Ravi Field', claims: 1, amount: '800.00', oldestDays: 10, overdue: '0.00' },
    ]);
    expect(r.overdue).toEqual({ claims: 1, amount: '1200.00' });
  });

  it('checks each reimbursement against the bank statement', async () => {
    const r = (await get().expect(200)).body;
    expect(r.reimbursements.map((x: any) => [x.number, x.status, x.amount, x.days, x.statementThrough])).toEqual([
      [c.D!.number, 'NOT_ON_STATEMENT', '300.00', 8, d(3)],
      [c.E!.number, 'AWAITING_STATEMENT', '250.00', 2, d(3)],
      [c.C!.number, 'CLEARED', '500.00', 12, d(3)],
    ]);
    expect(r.reimbursements[0]).toMatchObject({ claimant: 'Asha Sales', bankAccount: expect.stringMatching(/^1120 · /), statusLabel: 'Not on the statement' });
    expect(r.bank).toEqual({ cleared: 1, notOnStatement: 1, notOnStatementAmount: '300.00', awaiting: 1 });
  });

  it('reconciles as of an earlier date', async () => {
    // Twenty days ago: A and C were owed; F was already void; B, D and E not yet approved.
    const r = (await get(`?asOf=${d(20)}`).expect(200)).body;
    expect(r).toMatchObject({ ledger: '1700.00', claims: '1700.00', reconciled: true });
    expect(r.owed.map((o: any) => o.number)).toEqual([c.A!.number, c.C!.number]);
    expect(r.reimbursements).toEqual([]);
  });

  it('lists an entry on the account that no claim made', async () => {
    // The API refuses manual entries on the account; a migrated balance is set up in the database.
    const src = (await ctx.db.collection('journal_entries').findOne({ _id: c.A!.journalEntryId as never }))!;
    const id = randomUUID();
    await ctx.db.collection('journal_entries').insertOne({
      ...src, _id: id as never, entryNumber: 9001, source: 'IMPORT', memo: 'Balance from the old system', date: new Date(`${d(60)}T00:00:00Z`), idempotencyKey: null, idempotencyHash: null,
      lines: src.lines.map((l: Record<string, unknown>) => ({ ...l, id: randomUUID() })),
    });
    const r = (await get().expect(200)).body;
    expect(r).toMatchObject({ ledger: '3200.00', claims: '2000.00', difference: '1200.00', reconciled: false });
    expect(r.items).toEqual([{ kind: 'NOT_FROM_A_CLAIM', date: d(60), reference: 'JE-9001', description: 'Balance from the old system: an entry on the account that no expense claim made (import)', amount: '1200.00', entryId: id, claimId: null }]);
    await ctx.db.collection('journal_entries').deleteOne({ _id: id as never });
  });

  it('needs expenses.read, checks the date and keeps to the organisation', async () => {
    await get('', viewer).expect(200);
    await get('', ravi).expect(403);
    await get('?asOf=2026-13-01').expect(400);
    await get('?days=3').expect(400);
    await get('', outsider).expect(404);
    expect((await get('', outsider, other).expect(200)).body).toMatchObject({ account: { code: '2250' }, ledger: '0.00', claims: '0.00', reconciled: true, owed: [], reimbursements: [] });
  });
});
