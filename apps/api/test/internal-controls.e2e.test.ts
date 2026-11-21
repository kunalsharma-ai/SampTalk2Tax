import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueControlPeriod } from '@talk2tax/accounting-engine';
import { toDbDate } from '../src/common/dates';
import { runInOrg } from '../src/common/tenant-context';
import { bankReconciliations } from '../src/db/collections/banking';
import { controlTests } from '../src/db/collections/internal-controls';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Internal controls register (AUDIT-008, AUDIT-013) against the real API and database: controls
 * added from the library or written by the organisation, each with an owner; automatic checks
 * worked out from the books for an ended period; tests recorded by someone other than the owner,
 * kept as recorded and audited; permissions and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
// The fiscal year starts two months back, so last month is always inside the year created.
const FY_START = ((+T.slice(5, 7) + 9) % 12) + 1;
const due = dueControlPeriod('MONTHLY', T, FY_START);
type Control = { id: string; title: string; check: string | null; owner: { name: string }; status: string; duePeriod: { key: string }; tests?: { result: string; method: string; evidence: { summary: string; exceptions: string[] } | null; notes: string | null; testedBy: { name: string }; selfTested: boolean }[] };
const C = () => `${org.base}/controls`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Controls Owner');
  accountant = await registerUser(ctx, 'Controls Accountant');
  approver = await registerUser(ctx, 'Controls Approver');
  viewer = await registerUser(ctx, 'Controls Viewer');
  outsider = await registerUser(ctx, 'Controls Outsider');
  org = await createOrg(ctx, owner, { name: 'Controls Test Pvt Ltd', fiscalYearStartMonth: FY_START });
  other = await createOrg(ctx, outsider, { name: 'Other Controls Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  // Money moved through the bank last month.
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: due.to, post: true, lines: [{ accountId: org.acc['1120'], debit: '5000.00' }, { accountId: org.acc['3100'], credit: '5000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('internal controls register', () => {
  let bank: Control;
  let lock: Control;
  let manual: Control;

  it('adds controls from the library and the organisation’s own, each with an owner', async () => {
    const empty = (await ctx.http().get(C()).set(approver.auth).expect(200)).body;
    expect(empty.controls).toEqual([]);
    expect(empty.library.map((t: { id: string }) => t.id)).toContain('BANK_RECONCILIATION');
    await ctx.http().get(C()).set(viewer.auth).expect(403);
    await ctx.http().post(C()).set(accountant.auth).send({ templateId: 'BANK_RECONCILIATION', ownerId: accountant.id }).expect(403);
    expect((await ctx.http().post(C()).set(owner.auth).send({ templateId: 'BANK_RECONCILIATION', ownerId: outsider.id }).expect(422)).body.error).toBe('OWNER_NOT_MEMBER');
    bank = (await ctx.http().post(C()).set(owner.auth).send({ templateId: 'BANK_RECONCILIATION', ownerId: accountant.id }).expect(201)).body;
    expect(bank).toMatchObject({ title: 'Bank accounts reconciled monthly', check: 'BANKS_RECONCILED', owner: { name: 'Controls Accountant' }, duePeriod: { key: due.key } });
    expect(['DUE', 'OVERDUE']).toContain(bank.status);
    expect((await ctx.http().post(C()).set(owner.auth).send({ templateId: 'BANK_RECONCILIATION', ownerId: owner.id }).expect(409)).body.error).toBe('DUPLICATE');
    lock = (await ctx.http().post(C()).set(owner.auth).send({ templateId: 'PERIOD_LOCK', ownerId: owner.id }).expect(201)).body;
    manual = (await ctx.http().post(C()).set(owner.auth).send({ title: 'Payroll changes approved', objective: 'Salary changes are approved before the pay run.', area: 'PAYROLL', frequency: 'MONTHLY', ownerId: approver.id }).expect(201)).body;
    expect(manual.check).toBeNull();
    const list = (await ctx.http().get(C()).set(approver.auth).expect(200)).body;
    expect(list.controls.map((c: Control) => c.title).sort()).toEqual(['Bank accounts reconciled monthly', 'Closed months locked', 'Payroll changes approved']);
    expect(list.library.map((t: { id: string }) => t.id)).not.toContain('BANK_RECONCILIATION');
  });

  it('checks the books for an ended period and records the result by someone other than the owner', async () => {
    expect((await ctx.http().post(`${C()}/${bank.id}/check`).set(approver.auth).send({ period: T.slice(0, 7) }).expect(422)).body.error).toBe('PERIOD_NOT_ENDED');
    expect((await ctx.http().post(`${C()}/${bank.id}/check`).set(approver.auth).send({ period: '2026-Q1' }).expect(422)).body.error).toBe('INVALID_PERIOD');
    const failing = (await ctx.http().post(`${C()}/${bank.id}/check`).set(approver.auth).send({ period: due.key }).expect(201)).body;
    expect(failing).toMatchObject({ result: 'FAIL', exceptions: [expect.stringMatching(/^1120 .*: never reconciled$/)] });
    await runInOrg(org.orgId, () =>
      ctx.store.collection(bankReconciliations).insertOne({ accountId: org.acc['1120']!, startDate: toDbDate(due.from), statementDate: toDbDate(due.to), openingBalance: '0', statementBalance: '5000', ledgerBalance: '5000', uncleared: '0', status: 'COMPLETED', completedById: accountant.id, completedAt: new Date(), undoneById: null, undoneAt: null, undoReason: null }),
    );
    expect((await ctx.http().post(`${C()}/${bank.id}/tests`).set(accountant.auth).send({ period: due.key }).expect(403)).body.error).toBe('OWNER_CANNOT_TEST');
    const tested = (await ctx.http().post(`${C()}/${bank.id}/tests`).set(approver.auth).send({ period: due.key, result: 'FAIL' }).expect(201)).body as Control;
    expect(tested.status).toBe('PASSED');
    expect(tested.tests![0]).toMatchObject({ result: 'PASS', method: 'AUTOMATIC', evidence: { summary: '1 bank accounts with postings checked; no exceptions.', exceptions: [] }, testedBy: { name: 'Controls Approver' }, selfTested: false });

    const locked = (await ctx.http().post(`${C()}/${lock.id}/tests`).set(accountant.auth).send({ period: due.key }).expect(201)).body as Control;
    expect(locked.status).toBe('FAILED');
    // Every month of the year created that has ended is still open.
    const open = locked.tests![0]!.evidence!.exceptions;
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((e) => / is still open$/.test(e))).toBe(true);
  });

  it('records a manual test with its result and what was checked', async () => {
    expect((await ctx.http().post(`${C()}/${manual.id}/tests`).set(accountant.auth).send({ period: due.key, notes: 'Checked every salary change' }).expect(422)).body.error).toBe('RESULT_REQUIRED');
    expect((await ctx.http().post(`${C()}/${manual.id}/tests`).set(accountant.auth).send({ period: due.key, result: 'PASS' }).expect(422)).body.error).toBe('NOTES_REQUIRED');
    const m = (await ctx.http().post(`${C()}/${manual.id}/tests`).set(accountant.auth).send({ period: due.key, result: 'PASS', notes: 'Checked every salary change against the signed approval' }).expect(201)).body as Control;
    expect(m).toMatchObject({ status: 'PASSED', tests: [{ method: 'MANUAL', result: 'PASS', evidence: null, notes: 'Checked every salary change against the signed approval' }] });
    const [t] = await runInOrg(org.orgId, () => ctx.store.collection(controlTests).find({ controlId: manual.id }));
    await expect(runInOrg(org.orgId, () => ctx.store.collection(controlTests).updateOne({ id: t!.id }, { $set: { result: 'FAIL' } }))).rejects.toThrow(/kept as it was recorded/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(controlTests).deleteOne({ id: t!.id }))).rejects.toThrow(/kept as a record/);
  });

  it('changes the owner, takes a control out of use, and audits every step', async () => {
    const changed = (await ctx.http().put(`${C()}/${manual.id}`).set(owner.auth).send({ title: 'Payroll changes approved', objective: 'Salary changes are approved before the pay run.', area: 'PAYROLL', frequency: 'QUARTERLY', ownerId: owner.id, active: false }).expect(200)).body;
    expect(changed).toMatchObject({ owner: { name: 'Controls Owner' }, frequency: 'QUARTERLY', status: 'INACTIVE' });
    expect((await ctx.http().post(`${C()}/${manual.id}/tests`).set(accountant.auth).send({ period: due.key, result: 'PASS', notes: 'Checked every salary change' }).expect(409)).body.error).toBe('INACTIVE');
    expect((await ctx.http().put(`${C()}/${manual.id}`).set(owner.auth).send({ title: 'Closed months locked', objective: 'x', area: 'LEDGER', frequency: 'MONTHLY', ownerId: owner.id }).expect(409)).body.error).toBe('DUPLICATE');
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=internal_control`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((e) => e.action).sort();
    expect(actions).toEqual(['control.created', 'control.created', 'control.created', 'control.tested', 'control.tested', 'control.tested', 'control.updated']);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(C()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/controls`).set(outsider.auth).expect(200)).body.controls).toEqual([]);
    await ctx.http().get(`${other.base}/controls/${bank.id}`).set(outsider.auth).expect(404);
    await ctx.http().post(`${other.base}/controls/${bank.id}/tests`).set(outsider.auth).send({ period: due.key }).expect(404);
  });
});
