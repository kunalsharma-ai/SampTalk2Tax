import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInOrg } from '../src/common/tenant-context';
import { auditEngagements } from '../src/db/collections/audit-engagements';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Internal audit workspace (AUDIT-001) against the real API and database: an engagement with a
 * lead and a different reviewer who can approve; the lead plans steps and moves it on; steps are
 * done by their assignee or the lead and signed off only by the reviewer; linked samples must be
 * tested before review; work sent back; closed with a conclusion and kept as closed; audited;
 * permissions and tenant isolation.
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
type Step = { id: string; title: string; status: string; work: string | null; assignee: { name: string }; doneBy: { name: string } | null; signedOffBy: { name: string } | null; canDo: boolean; canReview: boolean };
type Engagement = { id: string; reference: string; status: string; progress: { steps: number; done: number; signedOff: number }; steps: Step[]; samples: { reference: string; status: string }[]; findings: { reference: string; status: string }[]; conclusion: string | null; history: { action: string; by: { name: string }; note: string }[]; canPlan: boolean; isLead: boolean; isReviewer: boolean };
const E = () => `${org.base}/audit-engagements`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Engagement Owner');
  accountant = await registerUser(ctx, 'Engagement Lead');
  approver = await registerUser(ctx, 'Engagement Reviewer');
  viewer = await registerUser(ctx, 'Engagement Viewer');
  outsider = await registerUser(ctx, 'Engagement Outsider');
  org = await createOrg(ctx, owner, { name: 'Engagement Test Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Engagement Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const a of ['1200.00', '4800.00']) await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send({ date: T, post: true, memo: `Engagement test ${a}`, lines: [{ accountId: org.acc['6200'], debit: a }, { accountId: org.acc['1120'], credit: a }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('internal audit engagements', () => {
  let e: Engagement;
  let sampleId: string;
  const post = (who: TestUser, path: string, body: object, status: number) => ctx.http().post(`${E()}/${e.id}${path}`).set(who.auth).send(body).expect(status);

  it('starts an engagement with a lead and a different reviewer who can approve', async () => {
    const body = { name: 'Payments audit', objective: 'Check that supplier payments are approved and recorded', scopeFrom: `${T.slice(0, 7)}-01`, scopeTo: T, leadId: accountant.id, reviewerId: approver.id };
    expect((await ctx.http().get(E()).set(viewer.auth).expect(403)).body.error).toBeDefined();
    expect((await ctx.http().post(E()).set(owner.auth).send({ ...body, reviewerId: accountant.id }).expect(422)).body.error).toBe('SAME_PERSON');
    expect((await ctx.http().post(E()).set(owner.auth).send({ ...body, reviewerId: viewer.id }).expect(422)).body.error).toBe('NOT_ELIGIBLE');
    expect((await ctx.http().post(E()).set(owner.auth).send({ ...body, scopeTo: '2020-01-01' }).expect(422)).body.error).toBe('INVALID_SCOPE');
    e = (await ctx.http().post(E()).set(owner.auth).send(body).expect(201)).body;
    expect(e).toMatchObject({ reference: 'IA-001', status: 'PLANNING', progress: { steps: 0, done: 0, signedOff: 0 }, isLead: false });
    const list = (await ctx.http().get(E()).set(accountant.auth).expect(200)).body;
    expect(list.engagements).toMatchObject([{ reference: 'IA-001', mine: true, lead: { name: 'Engagement Lead' }, reviewer: { name: 'Engagement Reviewer' } }]);
    expect(list.reviewers.map((r: { name: string }) => r.name)).toEqual(['Engagement Owner', 'Engagement Reviewer']);
  });

  it('lets only the lead plan the work and move it to fieldwork', async () => {
    expect((await post(approver, '/steps', { title: 'Trace payments to bills', assigneeId: accountant.id }, 403)).body.error).toBe('NOT_LEAD');
    expect((await post(accountant, '/steps', { title: 'Trace payments to bills', assigneeId: approver.id }, 422)).body.error).toBe('REVIEWER_ASSIGNED');
    expect((await post(accountant, '/move', { status: 'FIELDWORK', note: '' }, 409)).body.message).toMatch(/at least one step/);
    await post(accountant, '/steps', { title: 'Check payment approvals', assigneeId: owner.id }, 201);
    e = (await post(accountant, '/steps', { title: 'Trace payments to bills', assigneeId: accountant.id }, 201)).body;
    expect(e.steps.map((s) => [s.title, s.assignee.name, s.status])).toEqual([['Check payment approvals', 'Engagement Owner', 'OPEN'], ['Trace payments to bills', 'Engagement Lead', 'OPEN']]);
    expect((await post(accountant, '/move', { status: 'REVIEW', note: '' }, 409)).body.error).toBe('CANNOT_MOVE');
    expect((await post(approver, '/move', { status: 'FIELDWORK', note: '' }, 403)).body.error).toBe('NOT_ALLOWED');
    e = (await post(accountant, '/move', { status: 'FIELDWORK', note: 'Starting work' }, 201)).body;
    expect(e.status).toBe('FIELDWORK');
  });

  it('links samples and findings, and holds review until linked samples are tested', async () => {
    const sample = (await ctx.http().post(`${org.base}/audit-samples`).set(accountant.auth).send({ name: 'Payments month', population: 'JOURNALS', from: T, to: T, method: 'RANDOM', size: 2, seed: 'ia-1' }).expect(201)).body;
    sampleId = sample.id;
    const finding = (await ctx.http().post(`${org.base}/audit-findings`).set(owner.auth).send({ title: 'Payments approved after release', description: 'Two payments were approved after the bank sent them.', severity: 'MEDIUM', ownerId: accountant.id, plan: 'Approve payment batches before release' }).expect(201)).body;
    const linkable = (await ctx.http().get(`${E()}/${e.id}/linkable`).set(accountant.auth).expect(200)).body;
    expect(linkable.samples.map((s: { label: string }) => s.label)).toEqual(['S-001 Payments month']);
    expect((await post(owner, '/links', { kind: 'SAMPLE', id: sampleId }, 403)).body.error).toBe('NOT_LEAD');
    await post(accountant, '/links', { kind: 'SAMPLE', id: sampleId }, 201);
    expect((await post(accountant, '/links', { kind: 'SAMPLE', id: sampleId }, 409)).body.error).toBe('ALREADY_LINKED');
    e = (await post(accountant, '/links', { kind: 'FINDING', id: finding.id }, 201)).body;
    expect(e.samples).toMatchObject([{ reference: 'S-001', status: 'OPEN' }]);
    expect(e.findings).toMatchObject([{ reference: 'F-001', status: 'OPEN' }]);

    expect((await post(approver, `/steps/${e.steps[0]!.id}/done`, { work: 'Checked every payment' }, 403)).body.error).toBe('CANNOT_DO_STEP');
    expect((await post(owner, `/steps/${e.steps[0]!.id}/done`, { work: 'ok' }, 409)).body.message).toMatch(/10 characters/);
    await post(owner, `/steps/${e.steps[0]!.id}/done`, { work: 'All 14 payments had an approval before release' }, 201);
    e = (await post(accountant, `/steps/${e.steps[1]!.id}/done`, { work: 'Traced the sampled payments to approved bills' }, 201)).body;
    expect(e.progress).toEqual({ steps: 2, done: 2, signedOff: 0 });
    expect((await post(accountant, '/move', { status: 'REVIEW', note: '' }, 409)).body.message).toBe('1 linked sample is still being tested');
    for (const i of sample.items) await ctx.http().post(`${org.base}/audit-samples/${sampleId}/items/${i.refId}/result`).set(accountant.auth).send({ result: 'OK' }).expect(201);
    e = (await post(accountant, '/move', { status: 'REVIEW', note: 'Ready for review' }, 201)).body;
    expect(e).toMatchObject({ status: 'REVIEW', samples: [{ status: 'COMPLETED' }] });
  });

  it('is signed off only by the reviewer, who can send work back', async () => {
    const [a, b] = e.steps as [Step, Step];
    await post(accountant, `/steps/${a.id}/review`, { decision: 'SIGN_OFF', note: '' }, 403);
    await post(viewer, `/steps/${a.id}/review`, { decision: 'SIGN_OFF', note: '' }, 403);
    expect((await post(approver, `/steps/${b.id}/review`, { decision: 'REOPEN', note: 'no' }, 409)).body.message).toMatch(/more work/);
    e = (await post(approver, `/steps/${b.id}/review`, { decision: 'REOPEN', note: 'Trace the payments to the bank statement too' }, 201)).body;
    expect(e.steps[1]).toMatchObject({ status: 'OPEN', doneBy: null });
    expect((await post(approver, '/move', { status: 'CLOSED', note: 'Payments are approved and recorded properly' }, 409)).body.message).toBe('2 steps are not signed off yet');
    e = (await post(approver, '/move', { status: 'FIELDWORK', note: 'One step needs more work' }, 201)).body;
    await post(accountant, `/steps/${b.id}/done`, { work: 'Traced every sampled payment to the bank statement' }, 201);
    await post(accountant, '/move', { status: 'REVIEW', note: 'Done again' }, 201);
    await post(approver, `/steps/${a.id}/review`, { decision: 'SIGN_OFF', note: '' }, 201);
    e = (await post(approver, `/steps/${b.id}/review`, { decision: 'SIGN_OFF', note: '' }, 201)).body;
    expect(e.steps.map((s) => [s.status, s.signedOffBy?.name])).toEqual([['SIGNED_OFF', 'Engagement Reviewer'], ['SIGNED_OFF', 'Engagement Reviewer']]);
    expect((await post(approver, '/move', { status: 'CLOSED', note: 'Too short' }, 409)).body.message).toMatch(/conclusion/);
    e = (await post(approver, '/move', { status: 'CLOSED', note: 'Payments are approved before release and recorded against bills' }, 201)).body;
    expect(e).toMatchObject({ status: 'CLOSED', conclusion: 'Payments are approved before release and recorded against bills', progress: { steps: 2, done: 2, signedOff: 2 } });
    expect(e.history.map((h) => h.action)).toEqual(['Started', 'Step added', 'Step added', 'Fieldwork started', 'Sample linked', 'Finding linked', 'Step done', 'Step done', 'Sent for review', 'Step sent back', 'Sent back to fieldwork', 'Step done', 'Sent for review', 'Step signed off', 'Step signed off', 'Closed']);
  });

  it('keeps a closed engagement as it was closed, and audits every change', async () => {
    expect((await post(accountant, '/steps', { title: 'One more step', assigneeId: accountant.id }, 409)).body.error).toBe('NOT_PLANNING');
    expect((await post(approver, '/move', { status: 'REVIEW', note: 'Reopen it' }, 409)).body.message).toBe('This engagement is closed');
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditEngagements).updateOne({ id: e.id }, { $set: { conclusion: 'Changed' } }))).rejects.toThrow(/kept as it was closed/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditEngagements).deleteOne({ id: e.id }))).rejects.toThrow(/kept as a record/);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=audit_engagement`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((x) => x.action);
    expect(actions.filter((a) => a === 'audit_engagement.step_signed_off')).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(['audit_engagement.created', 'audit_engagement.step_added', 'audit_engagement.linked', 'audit_engagement.step_done', 'audit_engagement.step_reopened', 'audit_engagement.moved', 'audit_engagement.closed']));
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(E()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/audit-engagements`).set(outsider.auth).expect(200)).body.engagements).toEqual([]);
    await ctx.http().get(`${other.base}/audit-engagements/${e.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().post(`${other.base}/audit-engagements/${e.id}/links`).set(outsider.auth).send({ kind: 'SAMPLE', id: sampleId }).expect(404)).body.error).toBe('NOT_FOUND');
  });
});
