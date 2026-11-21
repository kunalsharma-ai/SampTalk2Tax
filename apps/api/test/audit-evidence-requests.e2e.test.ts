import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@talk2tax/accounting-engine';
import { runInOrg } from '../src/common/tenant-context';
import { auditEvidenceRequests } from '../src/db/collections/audit-evidence';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Audit evidence management (AUDIT-003) against the real API and database: the engagement lead
 * asks a member for evidence by a due date; only that member (or the lead) attaches files, and only
 * while the evidence is still requested; it is submitted with the files' SHA-256, returned with
 * what is missing, and accepted by the lead or reviewer but never by whoever submitted it; open
 * requests hold the engagement back from review; accepted evidence is kept as accepted; audited
 * with file references; tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let lead: TestUser;
let reviewer: TestUser;
let staff: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type Req = { id: string; reference: string; status: string; overdue: boolean; owner: { name: string }; engagement: { reference: string }; files: { attachmentId: string; fileName: string; sha256: string }[]; submittedBy: { name: string } | null; acceptedBy: { name: string } | null; history: { action: string; note: string; by: { name: string } }[]; canUpload: boolean; canReview: boolean; mine: boolean };
const R = () => `${org.base}/audit-evidence`;
let engagementId: string;
let stepId: string;
const upload = (user: TestUser, id: string, body: Buffer, fileName: string) => ctx.http().post(`${org.base}/attachments?entityType=AUDIT_EVIDENCE&entityId=${id}&fileName=${encodeURIComponent(fileName)}`).set(user.auth).set('content-type', 'application/pdf').send(body);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Evidence Owner');
  lead = await registerUser(ctx, 'Evidence Lead');
  reviewer = await registerUser(ctx, 'Evidence Reviewer');
  staff = await registerUser(ctx, 'Evidence Staff');
  viewer = await registerUser(ctx, 'Evidence Viewer');
  outsider = await registerUser(ctx, 'Evidence Outsider');
  org = await createOrg(ctx, owner, { name: 'Evidence Test Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Evidence Ltd' });
  for (const [u, role] of [[lead, 'ACCOUNTANT'], [reviewer, 'APPROVER'], [staff, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const e = (await ctx.http().post(`${org.base}/audit-engagements`).set(owner.auth).send({ name: 'Bank audit', objective: 'Check the bank balances are supported', scopeFrom: T, scopeTo: T, leadId: lead.id, reviewerId: reviewer.id }).expect(201)).body;
  engagementId = e.id;
  stepId = (await ctx.http().post(`${org.base}/audit-engagements/${e.id}/steps`).set(lead.auth).send({ title: 'Agree balances to statements', assigneeId: lead.id }).expect(201)).body.steps[0].id;
  await ctx.http().post(`${org.base}/audit-engagements/${e.id}/move`).set(lead.auth).send({ status: 'FIELDWORK', note: '' }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('audit evidence requests', () => {
  let a: Req;
  let b: Req;

  it('is asked for by the engagement lead from a member other than the reviewer', async () => {
    const body = { engagementId, title: 'October bank statement', details: 'The signed statement for the main account', ownerId: staff.id, dueDate: addDays(T, 7) };
    await ctx.http().post(R()).set(viewer.auth).send(body).expect(403);
    expect((await ctx.http().post(R()).set(reviewer.auth).send(body).expect(403)).body.error).toBe('NOT_LEAD');
    expect((await ctx.http().post(R()).set(lead.auth).send({ ...body, ownerId: reviewer.id }).expect(422)).body.error).toBe('REVIEWER_ASKED');
    expect((await ctx.http().post(R()).set(lead.auth).send({ ...body, ownerId: viewer.id }).expect(422)).body.error).toBe('NOT_ELIGIBLE');
    expect((await ctx.http().post(R()).set(lead.auth).send({ ...body, dueDate: '2020-01-01' }).expect(422)).body.error).toBe('DUE_IN_PAST');
    a = (await ctx.http().post(R()).set(lead.auth).send(body).expect(201)).body;
    expect(a).toMatchObject({ reference: 'ER-001', status: 'REQUESTED', overdue: false, owner: { name: 'Evidence Staff' }, engagement: { reference: 'IA-001' }, files: [], canUpload: true, canReview: false });
    b = (await ctx.http().post(R()).set(lead.auth).send({ ...body, title: 'Bank reconciliation', ownerId: lead.id, dueDate: T }).expect(201)).body;
    const mine = (await ctx.http().get(R()).set(staff.auth).expect(200)).body;
    expect(mine.summary).toEqual({ requested: 2, submitted: 0, accepted: 0, overdue: 0, mine: 1 });
    expect(mine.requests.find((r: Req) => r.id === a.id)).toMatchObject({ mine: true, canUpload: true });
  });

  it('takes files only from the person asked (or the lead), and only while requested', async () => {
    expect((await ctx.http().post(`${R()}/${a.id}/submit`).set(staff.auth).send({ note: '' }).expect(409)).body.message).toBe('Attach at least one file first');
    expect((await upload(reviewer, a.id, pdf('wrong person'), 'statement.pdf').expect(403)).body.error).toBe('FORBIDDEN');
    expect((await upload(owner, a.id, pdf('owner'), 'statement.pdf').expect(403)).body.error).toBe('FORBIDDEN');
    await upload(viewer, a.id, pdf('viewer'), 'statement.pdf').expect(403);
    await upload(staff, a.id, pdf('first statement'), 'statement.pdf').expect(201);
    expect((await ctx.http().get(`${org.base}/attachments?entityType=AUDIT_EVIDENCE&entityId=${a.id}`).set(reviewer.auth).expect(200)).body).toHaveLength(1);
    await ctx.http().get(`${org.base}/attachments?entityType=AUDIT_EVIDENCE&entityId=${a.id}`).set(viewer.auth).expect(403);
    await ctx.http().post(`${R()}/${a.id}/submit`).set(reviewer.auth).send({ note: '' }).expect(403);
    a = (await ctx.http().post(`${R()}/${a.id}/submit`).set(staff.auth).send({ note: 'Signed by the bank' }).expect(201)).body;
    expect(a).toMatchObject({ status: 'SUBMITTED', submittedBy: { name: 'Evidence Staff' }, files: [{ fileName: 'statement.pdf', sha256: sha(pdf('first statement')) }] });
    expect((await upload(staff, a.id, pdf('late'), 'late.pdf').expect(409)).body.error).toBe('EVIDENCE_NOT_OPEN');
  });

  it('is returned with what is missing, then accepted by someone other than who submitted it', async () => {
    await ctx.http().post(`${R()}/${a.id}/review`).set(staff.auth).send({ decision: 'ACCEPT', note: '' }).expect(403);
    expect((await ctx.http().post(`${R()}/${a.id}/review`).set(lead.auth).send({ decision: 'RETURN', note: 'no' }).expect(409)).body.message).toMatch(/what is missing/);
    a = (await ctx.http().post(`${R()}/${a.id}/review`).set(lead.auth).send({ decision: 'RETURN', note: 'Page 2 of the statement is missing' }).expect(201)).body;
    expect(a).toMatchObject({ status: 'REQUESTED', submittedBy: null });
    await upload(staff, a.id, pdf('page two'), 'statement page 2.pdf').expect(201);
    await ctx.http().post(`${R()}/${a.id}/submit`).set(staff.auth).send({ note: '' }).expect(201);
    a = (await ctx.http().post(`${R()}/${a.id}/review`).set(reviewer.auth).send({ decision: 'ACCEPT', note: 'Agrees to the ledger' }).expect(201)).body;
    expect(a).toMatchObject({ status: 'ACCEPTED', acceptedBy: { name: 'Evidence Reviewer' } });
    expect(a.files.map((f) => f.fileName)).toEqual(['statement.pdf', 'statement page 2.pdf']);
    expect(a.history.map((h) => [h.action, h.by.name])).toEqual([['Requested', 'Evidence Lead'], ['Submitted', 'Evidence Staff'], ['Returned', 'Evidence Lead'], ['Submitted', 'Evidence Staff'], ['Accepted', 'Evidence Reviewer']]);
    expect(a.history[3]!.note).toBe('statement.pdf, statement page 2.pdf');
  });

  it('holds the engagement back from review until all evidence is accepted', async () => {
    await upload(lead, b.id, pdf('rec'), 'reconciliation.pdf').expect(201);
    await ctx.http().post(`${R()}/${b.id}/submit`).set(lead.auth).send({ note: '' }).expect(201);
    expect((await ctx.http().post(`${R()}/${b.id}/review`).set(lead.auth).send({ decision: 'ACCEPT', note: '' }).expect(403)).body.message).toMatch(/Someone other/);
    await ctx.http().post(`${org.base}/audit-engagements/${engagementId}/steps/${stepId}/done`).set(lead.auth).send({ work: 'Agreed every balance to the statement' }).expect(201);
    expect((await ctx.http().post(`${org.base}/audit-engagements/${engagementId}/move`).set(lead.auth).send({ status: 'REVIEW', note: '' }).expect(409)).body.message).toBe('1 evidence request is not accepted yet');
    await ctx.http().post(`${R()}/${b.id}/review`).set(reviewer.auth).send({ decision: 'ACCEPT', note: '' }).expect(201);
    const e = (await ctx.http().post(`${org.base}/audit-engagements/${engagementId}/move`).set(lead.auth).send({ status: 'REVIEW', note: '' }).expect(201)).body;
    expect(e.evidence.map((r: { reference: string; status: string; files: number }) => [r.reference, r.status, r.files])).toEqual([['ER-001', 'ACCEPTED', 2], ['ER-002', 'ACCEPTED', 1]]);
    expect((await ctx.http().post(R()).set(lead.auth).send({ engagementId, title: 'One more', details: '', ownerId: staff.id, dueDate: T }).expect(409)).body.error).toBe('NOT_FIELDWORK');
  });

  it('keeps accepted evidence as accepted, and audits it with the files', async () => {
    const fileId = a.files[0]!.attachmentId;
    expect((await ctx.http().post(`${org.base}/attachments/${fileId}/remove`).set(staff.auth).send({ reason: 'Wrong file' }).expect(409)).body.error).toBe('EVIDENCE_NOT_OPEN');
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditEvidenceRequests).updateOne({ id: a.id }, { $set: { status: 'REQUESTED' } }))).rejects.toThrow(/kept as it was accepted/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditEvidenceRequests).deleteOne({ id: b.id }))).rejects.toThrow(/kept as a record/);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=audit_evidence_request&entityId=${a.id}`).set(owner.auth).expect(200)).body;
    const events = (audit.items ?? audit) as { action: string; data: { evidence?: { fileName: string; sha256: string }[] } }[];
    expect(events.map((x) => x.action).sort()).toEqual(['audit_evidence.accepted', 'audit_evidence.requested', 'audit_evidence.returned', 'audit_evidence.submitted', 'audit_evidence.submitted']);
    expect(events.find((x) => x.action === 'audit_evidence.accepted')!.data.evidence?.map((f) => f.sha256)).toEqual([sha(pdf('first statement')), sha(pdf('page two'))]);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(R()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/audit-evidence`).set(outsider.auth).expect(200)).body.requests).toEqual([]);
    await ctx.http().get(`${other.base}/audit-evidence/${a.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().post(`${other.base}/attachments?entityType=AUDIT_EVIDENCE&entityId=${a.id}&fileName=x.pdf`).set(outsider.auth).set('content-type', 'application/pdf').send(pdf('steal')).expect(404)).body.error).toBe('NOT_FOUND');
  });
});
