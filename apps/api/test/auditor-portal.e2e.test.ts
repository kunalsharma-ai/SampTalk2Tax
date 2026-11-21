import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, AUDITOR_PORTAL_TOKEN_PATTERN, makeAuditorPortalToken } from '@talk2tax/accounting-engine';
import { runInOrg } from '../src/common/tenant-context';
import { auditorPortalLinks } from '../src/db/collections/auditor-portal';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * External auditor portal (AUDIT-002) against the real API and database: owners and admins make an
 * expiring, read-only link to one engagement for a named auditor; the auditor sees the engagement,
 * accepted evidence only (and can open those files, audited), findings, samples and the trial
 * balance; withdrawn and expired links stop working; links kept as a record; tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let lead: TestUser;
let reviewer: TestUser;
let staff: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let engagementId: string;
let accepted: { id: string };
let hiddenFile: string;
let acceptedFile: string;
const L = () => `${org.base}/audit-engagements/${engagementId}/auditor-links`;
const upload = (user: TestUser, id: string, body: Buffer, fileName: string) => ctx.http().post(`${org.base}/attachments?entityType=AUDIT_EVIDENCE&entityId=${id}&fileName=${encodeURIComponent(fileName)}`).set(user.auth).set('content-type', 'application/pdf').send(body).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Portal Owner');
  lead = await registerUser(ctx, 'Portal Lead');
  reviewer = await registerUser(ctx, 'Portal Reviewer');
  staff = await registerUser(ctx, 'Portal Staff');
  outsider = await registerUser(ctx, 'Portal Outsider');
  org = await createOrg(ctx, owner, { name: 'Auditor Portal Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Portal Ltd' });
  for (const [u, role] of [[lead, 'ACCOUNTANT'], [reviewer, 'APPROVER'], [staff, 'ACCOUNTANT']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().post(`${org.base}/journals`).set(lead.auth).send({ date: T, post: true, memo: 'Office rent', lines: [{ accountId: org.acc['6200'], debit: '25000.00' }, { accountId: org.acc['1120'], credit: '25000.00' }] }).expect(201);
  const e = (await ctx.http().post(`${org.base}/audit-engagements`).set(owner.auth).send({ name: 'Rent audit', objective: 'Check rent is supported by the agreement', scopeFrom: T, scopeTo: T, leadId: lead.id, reviewerId: reviewer.id }).expect(201)).body;
  engagementId = e.id;
  await ctx.http().post(`${org.base}/audit-engagements/${e.id}/steps`).set(lead.auth).send({ title: 'Agree rent to the agreement', assigneeId: staff.id }).expect(201);
  await ctx.http().post(`${org.base}/audit-engagements/${e.id}/move`).set(lead.auth).send({ status: 'FIELDWORK', note: '' }).expect(201);
  const ask = (title: string) => ctx.http().post(`${org.base}/audit-evidence`).set(lead.auth).send({ engagementId, title, details: '', ownerId: staff.id, dueDate: addDays(T, 5) }).expect(201);
  accepted = (await ask('Rent agreement')).body;
  const pending = (await ask('Landlord confirmation')).body;
  acceptedFile = (await upload(staff, accepted.id, pdf('agreement'), 'rent agreement.pdf')).body.id;
  hiddenFile = (await upload(staff, pending.id, pdf('draft'), 'draft confirmation.pdf')).body.id;
  await ctx.http().post(`${org.base}/audit-evidence/${accepted.id}/submit`).set(staff.auth).send({ note: '' }).expect(201);
  await ctx.http().post(`${org.base}/audit-evidence/${accepted.id}/review`).set(reviewer.auth).send({ decision: 'ACCEPT', note: 'Matches' }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('external auditor portal', () => {
  let token: string;
  let linkId: string;
  const P = (t = token) => `/v1/auditor-portal/${t}`;

  it('lets only owners and admins make an expiring link, shown once', async () => {
    await ctx.http().post(L()).set(lead.auth).send({ auditorName: 'Asha Auditor', expiresInDays: 30 }).expect(403);
    await ctx.http().post(L()).set(owner.auth).send({ auditorName: 'Asha Auditor', expiresInDays: 365 }).expect(400);
    await ctx.http().post(L()).set(owner.auth).send({ auditorName: 'Asha Auditor' }).expect(400);
    const made = (await ctx.http().post(L()).set(owner.auth).send({ auditorName: 'Asha Auditor', firm: 'Asha & Co', expiresInDays: 30 }).expect(201)).body;
    token = made.token;
    linkId = made.id;
    expect(token).toMatch(AUDITOR_PORTAL_TOKEN_PATTERN);
    expect(made.path).toBe(`/auditor-portal/${token}`);
    const list = (await ctx.http().get(L()).set(lead.auth).expect(200)).body;
    expect(list).toMatchObject([{ auditorName: 'Asha Auditor', firm: 'Asha & Co', prefix: token.slice(5, 13), state: 'ACTIVE', viewCount: 0, createdBy: 'Portal Owner' }]);
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain('tokenHash');
  });

  it('shows the engagement read-only, with accepted evidence only and the trial balance', async () => {
    const p = (await ctx.http().get(P()).expect(200)).body;
    expect(p).toMatchObject({ organisation: { name: 'Auditor Portal Pvt Ltd' }, auditor: { name: 'Asha Auditor', firm: 'Asha & Co' }, engagement: { reference: 'IA-001', name: 'Rent audit', status: 'FIELDWORK', lead: 'Portal Lead', reviewer: 'Portal Reviewer', progress: { steps: 1, done: 0, signedOff: 0 } } });
    expect(p.evidence).toEqual([expect.objectContaining({ reference: 'ER-001', title: 'Rent agreement', acceptedBy: 'Portal Reviewer', files: [{ attachmentId: acceptedFile, fileName: 'rent agreement.pdf', sha256: sha(pdf('agreement')) }] })]);
    expect(JSON.stringify(p)).not.toContain('Landlord confirmation');
    expect(p.trialBalance).toMatchObject({ asOf: T, balanced: true, totals: { netDebit: '25000.00', netCredit: '25000.00' } });
    expect(p.trialBalance.rows.length).toBeGreaterThanOrEqual(2);
    expect((await ctx.http().get(L()).set(owner.auth).expect(200)).body[0]).toMatchObject({ viewCount: 1 });
  });

  it('opens accepted evidence files only, and audits each one', async () => {
    const res = await ctx.http().get(`${P()}/files/${acceptedFile}`).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(sha(res.body as Buffer)).toBe(sha(pdf('agreement')));
    expect(res.headers['cache-control']).toBe('private, no-store');
    await ctx.http().get(`${P()}/files/${hiddenFile}`).expect(404);
    await ctx.http().get(`${P()}/files/00000000-0000-4000-8000-000000000000`).expect(404);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=auditor_portal_link&entityId=${linkId}`).set(owner.auth).expect(200)).body;
    const events = (audit.items ?? audit) as { action: string; actorId: string | null; data: { fileName?: string; sha256?: string } }[];
    const opened = events.find((x) => x.action === 'auditor_portal.file_opened')!;
    expect(opened).toMatchObject({ actorId: null, data: { fileName: 'rent agreement.pdf', sha256: sha(pdf('agreement')) } });
    expect(events.map((x) => x.action).sort()).toEqual(['auditor_portal.file_opened', 'auditor_portal.link_created']);
    expect((await ctx.http().get(L()).set(owner.auth).expect(200)).body[0]).toMatchObject({ filesOpened: 1 });
  });

  it('stops working once withdrawn or expired', async () => {
    expect((await ctx.http().get(P('t2ta_' + 'x'.repeat(40))).expect(404)).body.error).toBe('PORTAL_LINK_INVALID');
    expect((await ctx.http().get(P('not-a-token')).expect(404)).body.error).toBe('PORTAL_LINK_INVALID');
    await ctx.http().post(`${L()}/${linkId}/revoke`).set(lead.auth).expect(403);
    const list = (await ctx.http().post(`${L()}/${linkId}/revoke`).set(owner.auth).expect(201)).body;
    expect(list[0]).toMatchObject({ state: 'REVOKED', revokedBy: 'Portal Owner' });
    expect((await ctx.http().post(`${L()}/${linkId}/revoke`).set(owner.auth).expect(409)).body.error).toBe('ALREADY_REVOKED');
    expect((await ctx.http().get(P()).expect(404)).body.message).toBe('Auditor Portal Pvt Ltd has withdrawn this link.');
    await ctx.http().get(`${P()}/files/${acceptedFile}`).expect(404);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditorPortalLinks).updateOne({ id: linkId }, { $set: { revokedAt: null } }))).rejects.toThrow(/stays withdrawn/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditorPortalLinks).deleteOne({ id: linkId }))).rejects.toThrow(/kept as a record/);

    const old = makeAuditorPortalToken((n) => randomBytes(n));
    await runInOrg(org.orgId, () => ctx.store.collection(auditorPortalLinks).insertOne({ engagementId, auditorName: 'Old Auditor', firm: null, prefix: old.slice(5, 13), tokenHash: sha(Buffer.from(old)), expiresAt: new Date(Date.now() - 60_000), createdById: owner.id, createdAt: new Date(Date.now() - 86_400_000), revokedAt: null, revokedById: null, lastSeenAt: null, viewCount: 0, filesOpened: 0 }));
    expect((await ctx.http().get(P(old)).expect(404)).body.message).toMatch(/has expired/);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(L()).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/audit-engagements/${engagementId}/auditor-links`).set(outsider.auth).expect(404);
    await ctx.http().post(`${other.base}/audit-engagements/${engagementId}/auditor-links`).set(outsider.auth).send({ auditorName: 'Spy', expiresInDays: 7 }).expect(404);
  });
});
