import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Balance sheet account reconciliations (GL-032) and control accounts against their subsidiary
 * ledgers (GL-023), against the real API and database: balances by account, items that explain
 * them, sign-off by the preparer, review by someone else, the ledger moving after review, reopening,
 * permissions, tenant isolation and the audit trail.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let R: string;

const journal = (lines: Record<string, unknown>[]) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, memo: 'Recon test', post: true, lines }).expect(201);
const row = (list: { accounts: { code: string }[] }, code: string) => list.accounts.find((a) => a.code === code) as Record<string, unknown>;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Recon Owner');
  accountant = await registerUser(ctx, 'Recon Accountant');
  viewer = await registerUser(ctx, 'Recon Viewer');
  org = await createOrg(ctx, owner, { name: 'Recon Pvt Ltd' });
  R = `${org.base}/account-reconciliations`;
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await journal([{ accountId: org.acc['1300'], debit: '12000.00' }, { accountId: org.acc['1120'], credit: '12000.00' }]);
  const c = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Asha Traders', isCustomer: true }).expect(201)).body;
  await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c.id, issueDate: T, dueDate: T, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '5000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('account reconciliations', () => {
  it('lists balance sheet accounts with their balances, and control accounts with their ledgers', async () => {
    const list = (await ctx.http().get(R).query({ asOf: T }).set(viewer.auth).expect(200)).body;
    expect(list.accounts.some((a: { type: string }) => a.type === 'REVENUE' || a.type === 'EXPENSE')).toBe(false);
    expect(row(list, '1300')).toMatchObject({ ledgerBalance: '12000.00', state: 'NOT_STARTED', subledgerBalance: null, isBank: false });
    expect(row(list, '1200')).toMatchObject({ ledgerBalance: '5000.00', subledgerBalance: '5000.00', subledgerDifference: '0.00' });
    expect(row(list, '1120')).toMatchObject({ ledgerBalance: '-12000.00', isBank: true });
    expect(list.counts.NOT_STARTED).toBe(list.accounts.length);
    const ar = (await ctx.http().get(`${R}/${org.acc['1200']}`).query({ asOf: T }).set(viewer.auth).expect(200)).body;
    expect(ar.suggestions).toEqual([{ description: 'Open items in the receivables ledger', reference: `Ageing at ${T}`, amount: '5000.00', kind: 'SUPPORT' }]);
    expect((await ctx.http().get(`${R}/${org.acc['4100']}`).query({ asOf: T }).set(viewer.auth).expect(422)).body.error).toBe('NOT_BALANCE_SHEET');
  });

  it('saves items as a draft and signs off only when they explain the balance', async () => {
    const url = `${R}/${org.acc['1300']}`;
    await ctx.http().put(url).set(viewer.auth).send({ asOf: T, items: [] }).expect(403);
    const bad = (await ctx.http().put(url).set(accountant.auth).send({ asOf: T, items: [{ description: ' ', amount: '1.005', kind: 'SUPPORT' }] }).expect(422)).body;
    expect(bad.error).toBe('RECON_INVALID');
    const short = (await ctx.http().put(url).set(accountant.auth).send({ asOf: T, items: [{ description: 'Stock count', reference: 'SC-31', amount: '11999', kind: 'SUPPORT' }] }).expect(200)).body;
    expect(short).toMatchObject({ status: 'DRAFT', state: 'DRAFT', difference: '1.00', balanced: false, savedLedgerBalance: '12000.00' });
    const nope = (await ctx.http().post(`${url}/prepare`).set(accountant.auth).send({ asOf: T }).expect(422)).body;
    expect(nope).toMatchObject({ error: 'RECON_NOT_BALANCED', message: 'The items leave 1.00 of the ledger balance 12000.00 unexplained' });
    await ctx.http().put(url).set(accountant.auth).send({ asOf: T, notes: 'Count on the last day', items: [{ description: 'Stock count', reference: 'SC-31', amount: '12500.00', kind: 'SUPPORT' }, { description: 'Goods received not yet billed', amount: '-500', kind: 'RECONCILING' }] }).expect(200);
    const prepared = (await ctx.http().post(`${url}/prepare`).set(accountant.auth).send({ asOf: T }).expect(201)).body;
    expect(prepared).toMatchObject({ status: 'PREPARED', supported: '12500.00', reconciling: '-500.00', difference: '0.00', balanced: true, preparedBy: 'Recon Accountant', notes: 'Count on the last day' });
  });

  it('is reviewed by someone other than the preparer, and then locked', async () => {
    const url = `${R}/${org.acc['1300']}`;
    expect((await ctx.http().post(`${url}/review`).set(accountant.auth).send({ asOf: T }).expect(403)).body.error).toBe('SAME_PERSON');
    await ctx.http().post(`${url}/review`).set(viewer.auth).send({ asOf: T }).expect(403);
    const reviewed = (await ctx.http().post(`${url}/review`).set(owner.auth).send({ asOf: T, note: 'Agreed to count sheets' }).expect(201)).body;
    expect(reviewed).toMatchObject({ status: 'REVIEWED', state: 'REVIEWED', reviewedBy: 'Recon Owner', preparedBy: 'Recon Accountant' });
    expect((await ctx.http().put(url).set(accountant.auth).send({ asOf: T, items: [] }).expect(409)).body.error).toBe('RECON_REVIEWED');
    const list = (await ctx.http().get(R).query({ asOf: T }).set(viewer.auth).expect(200)).body;
    expect(row(list, '1300')).toMatchObject({ state: 'REVIEWED', difference: '0.00', reviewedBy: 'Recon Owner' });
    expect(list.counts.REVIEWED).toBe(1);
  });

  it('shows a reviewed reconciliation as changed when the ledger moves, and reopens it with a reason', async () => {
    const url = `${R}/${org.acc['1300']}`;
    await journal([{ accountId: org.acc['1300'], debit: '300.00' }, { accountId: org.acc['1120'], credit: '300.00' }]);
    const moved = (await ctx.http().get(url).query({ asOf: T }).set(viewer.auth).expect(200)).body;
    expect(moved).toMatchObject({ state: 'CHANGED', ledgerBalance: '12300.00', savedLedgerBalance: '12000.00', difference: '300.00', balanced: false });
    await ctx.http().post(`${url}/reopen`).set(accountant.auth).send({ asOf: T, reason: '' }).expect(400);
    const reopened = (await ctx.http().post(`${url}/reopen`).set(accountant.auth).send({ asOf: T, reason: 'Late stock purchase posted' }).expect(201)).body;
    expect(reopened).toMatchObject({ status: 'DRAFT', state: 'DRAFT', preparedBy: null, reviewedBy: null });
    expect(reopened.history.map((h: { kind: string }) => h.kind)).toEqual(['SAVED', 'SAVED', 'PREPARED', 'REVIEWED', 'REOPENED']);
    expect(reopened.history[3]).toMatchObject({ note: 'Agreed to count sheets', by: 'Recon Owner' });
    expect(reopened.history[4]).toMatchObject({ note: 'Late stock purchase posted', by: 'Recon Accountant' });
  });

  it('keeps each organisation to its own accounts and records every step', async () => {
    const other = await registerUser(ctx, 'Recon Outsider');
    const theirs = await createOrg(ctx, other, { name: 'Other Recon Ltd' });
    await ctx.http().get(`${theirs.base}/account-reconciliations/${org.acc['1300']}`).query({ asOf: T }).set(other.auth).expect(404);
    await ctx.http().get(R).query({ asOf: T }).set(other.auth).expect(404);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'account_reconciliation' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['account_reconciliation.saved', 'account_reconciliation.saved', 'account_reconciliation.prepared', 'account_reconciliation.reviewed', 'account_reconciliation.reopened']);
  });
});
