import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Approval of manual journals (SEC-036) against the real API and database: the policy amount,
 * posting refused without approval, a request covering the draft as it is, approval by someone
 * else, changes withdrawing the request, rejection, small journals unaffected, system journals
 * untouched, permissions and the audit trail.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let entryId: string;
let requestId: string;

const lines = (amount: string) => [{ accountId: org.acc['6200'], debit: amount }, { accountId: org.acc['1120'], credit: amount }];
const draft = async (amount: string) => (await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send({ date: T, memo: `Rent ${amount}`, post: false, lines: lines(amount) }).expect(201)).body.id as string;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'JA Owner');
  accountant = await registerUser(ctx, 'JA Accountant');
  approver = await registerUser(ctx, 'JA Approver');
  viewer = await registerUser(ctx, 'JA Viewer');
  org = await createOrg(ctx, owner, { name: 'Journal Approvals Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('approval of manual journals', () => {
  it('is off until the owner sets an amount', async () => {
    expect((await ctx.http().get(`${org.base}/journal-approvals/policy`).set(viewer.auth).expect(200)).body).toMatchObject({ isActive: false, minAmount: null });
    await ctx.http().put(`${org.base}/journal-approvals/policy`).set(accountant.auth).send({ minAmount: '50000', isActive: true }).expect(403);
    expect((await ctx.http().put(`${org.base}/journal-approvals/policy`).set(owner.auth).send({ minAmount: '-1', isActive: true }).expect(422)).body.error).toBe('INVALID_AMOUNT');
    expect((await ctx.http().put(`${org.base}/journal-approvals/policy`).set(owner.auth).send({ minAmount: '50000', isActive: true }).expect(200)).body).toMatchObject({ isActive: true, minAmount: '50000.00' });
  });

  it('refuses to post a large journal without approval, and leaves small ones alone', async () => {
    const big = (await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send({ date: T, memo: 'Big', post: true, lines: lines('60000.00') }).expect(409)).body;
    expect(big).toMatchObject({ error: 'JOURNAL_APPROVAL_REQUIRED' });
    await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send({ date: T, memo: 'Small', post: true, lines: lines('49999.99') }).expect(201);
    entryId = await draft('60000.00');
    expect((await ctx.http().post(`${org.base}/journals/${entryId}/post`).set(accountant.auth).expect(409)).body.error).toBe('JOURNAL_APPROVAL_REQUIRED');
    const small = await draft('100.00');
    expect((await ctx.http().post(`${org.base}/journals/${small}/approval`).set(accountant.auth).send({}).expect(422)).body.error).toBe('APPROVAL_NOT_NEEDED');
    const state = (await ctx.http().get(`${org.base}/journals/${entryId}/approval`).set(viewer.auth).expect(200)).body;
    expect(state).toMatchObject({ required: true, minAmount: '50000', approved: false, current: null });
  });

  it('is approved by someone else, for the draft exactly as it was', async () => {
    const asked = (await ctx.http().post(`${org.base}/journals/${entryId}/approval`).set(accountant.auth).send({ note: 'Quarterly rent' }).expect(201)).body;
    requestId = asked.current.id;
    expect(asked.current).toMatchObject({ status: 'PENDING', requestedBy: 'JA Accountant', canWithdraw: true, canDecide: false });
    expect((await ctx.http().post(`${org.base}/journals/${entryId}/approval`).set(accountant.auth).send({}).expect(409)).body.error).toBe('ALREADY_REQUESTED');
    const inbox = (await ctx.http().get(`${org.base}/journal-approvals`).set(approver.auth).expect(200)).body;
    expect(inbox).toEqual([expect.objectContaining({ id: requestId, entryId, total: '60000.00', memo: 'Rent 60000.00', canDecide: true })]);
    expect((await ctx.http().post(`${org.base}/journal-approvals/${requestId}/approve`).set(accountant.auth).send({}).expect(403)).body.error).toBeDefined();
    await ctx.http().post(`${org.base}/journal-approvals/${requestId}/approve`).set(viewer.auth).send({}).expect(403);
    const ok = (await ctx.http().post(`${org.base}/journal-approvals/${requestId}/approve`).set(approver.auth).send({ note: 'Agreed to lease' }).expect(200)).body;
    expect(ok).toMatchObject({ approved: true, current: { status: 'APPROVED', decidedBy: 'JA Approver', coversCurrentDraft: true } });
  });

  it('withdraws the approval when the draft changes', async () => {
    await ctx.http().put(`${org.base}/journals/${entryId}`).set(accountant.auth).send({ date: T, memo: 'Rent 60000.00', lines: lines('65000.00') }).expect(200);
    const state = (await ctx.http().get(`${org.base}/journals/${entryId}/approval`).set(accountant.auth).expect(200)).body;
    expect(state).toMatchObject({ required: true, approved: false, current: null });
    expect(state.history[0]).toMatchObject({ status: 'CANCELLED', decisionNote: 'The draft was changed' });
    expect((await ctx.http().post(`${org.base}/journals/${entryId}/post`).set(accountant.auth).expect(409)).body.error).toBe('JOURNAL_APPROVAL_REQUIRED');
  });

  it('posts once approved again, and records a rejection with its reason', async () => {
    const id = (await ctx.http().post(`${org.base}/journals/${entryId}/approval`).set(accountant.auth).send({}).expect(201)).body.current.id;
    await ctx.http().post(`${org.base}/journal-approvals/${id}/approve`).set(owner.auth).send({}).expect(200);
    const posted = (await ctx.http().post(`${org.base}/journals/${entryId}/post`).set(accountant.auth).expect(200)).body;
    expect(posted).toMatchObject({ status: 'POSTED', totalDebit: '65000.00' });
    const other = await draft('70000.00');
    const rid = (await ctx.http().post(`${org.base}/journals/${other}/approval`).set(accountant.auth).send({}).expect(201)).body.current.id;
    expect((await ctx.http().post(`${org.base}/journal-approvals/${rid}/reject`).set(approver.auth).send({}).expect(422)).body.error).toBe('NOTE_REQUIRED');
    const rej = (await ctx.http().post(`${org.base}/journal-approvals/${rid}/reject`).set(approver.auth).send({ note: 'No lease for this' }).expect(200)).body;
    expect(rej.current).toMatchObject({ status: 'REJECTED', decisionNote: 'No lease for this' });
    // A rejected request can be asked again after fixing.
    await ctx.http().post(`${org.base}/journals/${other}/approval`).set(accountant.auth).send({}).expect(201);
  });

  it('does not hold up journals other modules post, and records every step', async () => {
    const c = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Big Customer', isCustomer: true }).expect(201)).body;
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c.id, issueDate: T, dueDate: T, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '90000.00' }] }).expect(201);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'journal_approval' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['journal_approval_policy.updated', 'journal_approval.requested', 'journal_approval.approved', 'journal_approval.cancelled', 'journal_approval.requested', 'journal_approval.approved', 'journal_approval.requested', 'journal_approval.rejected', 'journal_approval.requested']);
  });
});
