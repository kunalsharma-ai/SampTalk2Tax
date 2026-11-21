import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, dueControlPeriod } from '@talk2tax/accounting-engine';
import { runInOrg } from '../src/common/tenant-context';
import { auditFindings } from '../src/db/collections/audit-findings';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Audit findings and remediation (AUDIT-011, AUDIT-012) against the real API and database: a
 * finding raised from a failed control test (once) or by hand; the remediation owner works it to
 * ready for review; someone else closes it, and only after a later passing test when it came from
 * one; closed findings kept as closed; audited; permissions and tenant isolation.
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
const FY_START = ((+T.slice(5, 7) + 9) % 12) + 1;
const due = dueControlPeriod('MONTHLY', T, FY_START);
type Finding = { id: string; reference: string; title: string; description: string; status: string; dueDate: string; source: string; control: { title: string } | null; owner: { name: string }; updates: { status: string; note: string; by: { name: string } }[]; canUpdate: boolean; canClose: boolean };
const F = () => `${org.base}/audit-findings`;
let controlId: string;
let failedTest: string;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Findings Owner');
  accountant = await registerUser(ctx, 'Findings Accountant');
  approver = await registerUser(ctx, 'Findings Approver');
  viewer = await registerUser(ctx, 'Findings Viewer');
  outsider = await registerUser(ctx, 'Findings Outsider');
  org = await createOrg(ctx, owner, { name: 'Findings Test Pvt Ltd', fiscalYearStartMonth: FY_START });
  other = await createOrg(ctx, outsider, { name: 'Other Findings Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  // Closed months are not locked, so the control fails for last month.
  controlId = (await ctx.http().post(`${org.base}/controls`).set(owner.auth).send({ templateId: 'PERIOD_LOCK', ownerId: owner.id }).expect(201)).body.id;
  const tested = (await ctx.http().post(`${org.base}/controls/${controlId}/tests`).set(accountant.auth).send({ period: due.key }).expect(201)).body;
  expect(tested.tests[0].result).toBe('FAIL');
  failedTest = tested.tests[0].id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('audit findings and remediation', () => {
  let fromTest: Finding;
  let manual: Finding;

  it('raises a finding from a failed control test once, and one by hand', async () => {
    const plan = 'Lock every month once its close is signed off';
    await ctx.http().post(F()).set(viewer.auth).send({ testId: failedTest, severity: 'HIGH', ownerId: accountant.id, plan }).expect(403);
    expect((await ctx.http().post(F()).set(owner.auth).send({ testId: failedTest, severity: 'HIGH', ownerId: viewer.id, plan }).expect(422)).body.error).toBe('OWNER_NOT_MEMBER');
    fromTest = (await ctx.http().post(F()).set(accountant.auth).send({ testId: failedTest, severity: 'HIGH', ownerId: accountant.id, plan }).expect(201)).body;
    expect(fromTest).toMatchObject({ reference: 'F-001', title: `Closed months locked failed for ${due.key}`, source: 'CONTROL_TEST', control: { title: 'Closed months locked' }, status: 'OPEN', dueDate: addDays(T, 14), owner: { name: 'Findings Accountant' } });
    expect(fromTest.description).toMatch(/is still open/);
    expect((await ctx.http().post(F()).set(owner.auth).send({ testId: failedTest, severity: 'LOW', ownerId: owner.id, plan }).expect(409)).body.error).toBe('ALREADY_RAISED');
    const control = (await ctx.http().get(`${org.base}/controls/${controlId}`).set(owner.auth).expect(200)).body;
    expect(control.tests[0].finding).toMatchObject({ reference: 'F-001', status: 'OPEN' });

    expect((await ctx.http().post(F()).set(owner.auth).send({ severity: 'LOW', ownerId: approver.id, plan: 'Write a short procedure' }).expect(422)).body.error).toBe('TITLE_REQUIRED');
    expect((await ctx.http().post(F()).set(owner.auth).send({ title: 'x', description: 'y', severity: 'LOW', ownerId: approver.id, plan: 'Write a short procedure', dueDate: '2020-01-01' }).expect(422)).body.error).toBe('DUE_IN_PAST');
    manual = (await ctx.http().post(F()).set(owner.auth).send({ title: 'No written expense policy', description: 'Staff do not know what they may claim.', severity: 'LOW', ownerId: approver.id, plan: 'Write and share an expense policy' }).expect(201)).body;
    expect(manual).toMatchObject({ reference: 'F-002', source: 'MANUAL', control: null, dueDate: addDays(T, 60) });
  });

  it('is worked through by its remediation owner', async () => {
    const progress = (who: TestUser, id: string, body: object, status: number) => ctx.http().post(`${F()}/${id}/progress`).set(who.auth).send(body).expect(status);
    expect((await progress(approver, fromTest.id, { status: 'IN_PROGRESS', note: 'Looking into it now' }, 403)).body.error).toBe('NOT_OWNER');
    expect((await progress(accountant, fromTest.id, { status: 'READY_FOR_REVIEW', note: 'done' }, 409)).body.error).toBe('INVALID_UPDATE');
    await progress(accountant, fromTest.id, { status: 'IN_PROGRESS', note: 'Locking the months that are closed' }, 201);
    const ready = (await progress(accountant, fromTest.id, { status: 'READY_FOR_REVIEW', note: 'Every closed month is now locked' }, 201)).body as Finding;
    expect(ready.updates.map((u) => [u.status, u.by.name])).toEqual([['OPEN', 'Findings Accountant'], ['IN_PROGRESS', 'Findings Accountant'], ['READY_FOR_REVIEW', 'Findings Accountant']]);
    expect(ready).toMatchObject({ status: 'READY_FOR_REVIEW', canUpdate: true, canClose: false });
  });

  it('is closed by someone else only after a later passing test', async () => {
    const close = (who: TestUser, body: object, status: number) => ctx.http().post(`${F()}/${fromTest.id}/close`).set(who.auth).send(body).expect(status);
    await close(accountant, { note: 'All months locked now' }, 403);
    expect((await close(owner, { note: 'All months locked now' }, 409)).body.error).toBe('NO_PASSING_TEST');
    // Lock every period that has ended, then test the control again.
    const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { id: string; endDate: string; status: string }[];
    for (const p of periods.filter((x) => x.endDate.slice(0, 10) <= due.to && x.status === 'OPEN')) await ctx.http().post(`${org.base}/periods/${p.id}/lock`).set(owner.auth).expect(200);
    expect((await ctx.http().post(`${org.base}/controls/${controlId}/tests`).set(approver.auth).send({ period: due.key }).expect(201)).body.tests[0].result).toBe('PASS');
    expect((await close(owner, { note: 'ok' }, 422)).body.error).toBe('NOTE_REQUIRED');
    const closed = (await close(owner, { note: 'Retest passed; every closed month is locked' }, 201)).body as Finding;
    expect(closed).toMatchObject({ status: 'CLOSED', canUpdate: false, canClose: false });
    expect((await ctx.http().post(`${F()}/${fromTest.id}/progress`).set(accountant.auth).send({ status: 'IN_PROGRESS', note: 'Reopening this one' }).expect(409)).body.error).toBe('CLOSED');
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditFindings).updateOne({ id: fromTest.id }, { $set: { title: 'Changed' } }))).rejects.toThrow(/kept as it was closed/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditFindings).deleteOne({ id: manual.id }))).rejects.toThrow(/kept as a record/);
  });

  it('lists findings with counts and audits every step', async () => {
    const list = (await ctx.http().get(F()).set(approver.auth).expect(200)).body;
    expect(list.findings.map((f: Finding) => [f.reference, f.status])).toEqual([['F-002', 'OPEN'], ['F-001', 'CLOSED']]);
    expect(list.summary).toMatchObject({ open: 1, high: 0, readyForReview: 0 });
    expect((await ctx.http().get(`${F()}?status=CLOSED`).set(approver.auth).expect(200)).body.findings).toHaveLength(1);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=audit_finding`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((e) => e.action).sort();
    expect(actions).toEqual(['audit_finding.closed', 'audit_finding.raised', 'audit_finding.raised', 'audit_finding.updated', 'audit_finding.updated']);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(F()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/audit-findings`).set(outsider.auth).expect(200)).body.findings).toEqual([]);
    await ctx.http().get(`${other.base}/audit-findings/${manual.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().post(`${other.base}/audit-findings`).set(outsider.auth).send({ testId: failedTest, severity: 'LOW', ownerId: outsider.id, plan: 'Take over their finding' }).expect(404)).body.error).toBe('NOT_FOUND');
  });
});
