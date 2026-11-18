import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/** Evidence files and approval rules, against a real database. */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let vendorId: string;
let customerId: string;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-png-body')]);

function upload(user: TestUser, entityType: string, entityId: string, body: Buffer, fileName = 'receipt.pdf', contentType = 'application/pdf') {
  return ctx
    .http()
    .post(`${org.base}/attachments?entityType=${entityType}&entityId=${entityId}&fileName=${encodeURIComponent(fileName)}`)
    .set(user.auth)
    .set('Content-Type', contentType)
    .send(body);
}

function bill(user: TestUser, amount: string, post = false) {
  return ctx
    .http()
    .post(`${org.base}/purchases/documents`)
    .set(user.auth)
    .send({ kind: 'BILL', contactId: vendorId, issueDate: today(), reference: `SYN-${amount}`, post, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: amount }] });
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  accountant = await registerUser(ctx, 'Accountant');
  approver = await registerUser(ctx, 'Approver');
  viewer = await registerUser(ctx, 'Viewer');
  outsider = await registerUser(ctx, 'Outsider');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [
    [accountant, 'ACCOUNTANT'],
    [approver, 'APPROVER'],
    [viewer, 'VIEWER'],
  ] as const) {
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
  await createOrg(ctx, outsider, { name: 'Other Co' });
  vendorId = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Supplies', isVendor: true }).expect(201)).body.id;
  customerId = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Customer', isCustomer: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('attachments', () => {
  let billId: string;
  let fileId: string;

  beforeAll(async () => {
    billId = (await bill(accountant, '1000.00').expect(201)).body.id;
  });

  it('stores a file with its checksum and detected type, and serves it back unchanged', async () => {
    const res = (await upload(accountant, 'DOCUMENT', billId, PDF, '../../etc/Receipt Oct.pdf').expect(201)).body;
    expect(res).toMatchObject({ fileName: 'Receipt Oct.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, sha256: createHash('sha256').update(PDF).digest('hex') });
    fileId = res.id;
    const list = (await ctx.http().get(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}`).set(viewer.auth).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ uploadedBy: 'Accountant', removedAt: null });
    const dl = await ctx.http().get(`${org.base}/attachments/${fileId}/content`).set(viewer.auth).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''Receipt%20Oct.pdf`);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
  });

  it('checks the bytes, not the claimed type, and refuses empty, oversized and duplicate files', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect((await upload(accountant, 'DOCUMENT', billId, html, 'x.pdf').expect(415)).body.error).toBe('UNSUPPORTED_FILE');
    // Declared as a PNG but sent with a generic type: the bytes decide.
    expect((await upload(accountant, 'DOCUMENT', billId, PNG, 'photo', 'application/octet-stream').expect(201)).body.contentType).toBe('image/png');
    expect((await upload(accountant, 'DOCUMENT', billId, PDF).expect(409)).body.error).toBe('DUPLICATE_FILE');
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(accountant, 'DOCUMENT', billId, big).expect(413)).body.error).toBe('FILE_TOO_LARGE');
    await upload(accountant, 'DOCUMENT', billId, Buffer.alloc(0)).expect(422);
  });

  it('follows the record’s permissions and never crosses organisations', async () => {
    expect((await upload(viewer, 'DOCUMENT', billId, Buffer.concat([PDF, Buffer.from('v')])).expect(403)).body.error).toBe('FORBIDDEN');
    // An approver can read purchases but not change them.
    await upload(approver, 'DOCUMENT', billId, Buffer.concat([PDF, Buffer.from('a')])).expect(403);
    await ctx.http().get(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${org.base}/attachments/${fileId}/content`).set(outsider.auth).expect(404);
    // The outsider's own organisation cannot reach this file or record either.
    const other = (await ctx.http().get('/v1/orgs').set(outsider.auth).expect(200)).body[0].id;
    await ctx.http().get(`/v1/orgs/${other}/attachments/${fileId}/content`).set(outsider.auth).expect(404);
    await ctx.http().get(`/v1/orgs/${other}/attachments?entityType=DOCUMENT&entityId=${billId}`).set(outsider.auth).expect(404);
    await upload(accountant, 'PAYMENT', billId, PDF).expect(404);
  });

  it('attaches to journals, payments and bank lines under their own permissions', async () => {
    const je = (
      await ctx
        .http()
        .post(`${org.base}/journals`)
        .set(owner.auth)
        .send({ date: today(), memo: 'Synthetic', post: true, lines: [{ accountId: org.acc['6600'], debit: '10.00' }, { accountId: org.acc['1120'], credit: '10.00' }] })
        .expect(201)
    ).body;
    await upload(accountant, 'JOURNAL_ENTRY', je.id, PDF).expect(201);
    await upload(approver, 'JOURNAL_ENTRY', je.id, PNG).expect(403);
  });

  it('removes a file with a reason but keeps the record, and the bytes cannot be changed', async () => {
    await ctx.http().post(`${org.base}/attachments/${fileId}/remove`).set(accountant.auth).send({ reason: 'Wrong receipt' }).expect(200);
    await ctx.http().post(`${org.base}/attachments/${fileId}/remove`).set(accountant.auth).send({ reason: 'Again' }).expect(409);
    await ctx.http().get(`${org.base}/attachments/${fileId}/content`).set(accountant.auth).expect(410);
    expect((await ctx.http().get(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}`).set(accountant.auth).expect(200)).body).toHaveLength(1);
    const all = (await ctx.http().get(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}&includeRemoved=true`).set(accountant.auth).expect(200)).body;
    expect(all.find((a: { id: string }) => a.id === fileId)).toMatchObject({ removedReason: 'Wrong receipt' });
    // The same file can be attached again once the old copy is removed.
    await upload(accountant, 'DOCUMENT', billId, PDF).expect(201);
    await expect(sqlWrite(ctx, `UPDATE attachments SET content = 'x'::bytea WHERE id = '${fileId}'`)).rejects.toThrow(/cannot be changed/);
    await expect(sqlWrite(ctx, `DELETE FROM attachments WHERE id = '${fileId}'`)).rejects.toThrow(/cannot be deleted/);
    await expect(sqlWrite(ctx, `UPDATE attachments SET removed_reason = 'changed' WHERE id = '${fileId}'`)).rejects.toThrow(/cannot be changed/);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=attachment&entityId=${fileId}`).set(owner.auth).expect(200)).body;
    const actions = (audit.items ?? audit).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['attachment.added', 'attachment.removed']));
  });
});

describe('approvals', () => {
  it('only owners and admins set the rules', async () => {
    await ctx.http().put(`${org.base}/approval-policies/BILL`).set(accountant.auth).send({ minAmount: '5000' }).expect(403);
    const p = (await ctx.http().put(`${org.base}/approval-policies/BILL`).set(owner.auth).send({ minAmount: '5000', requireDifferentApprover: true }).expect(200)).body;
    expect(p).toMatchObject({ documentKind: 'BILL', configured: true, isActive: true, minAmount: '5000.00' });
    const all = (await ctx.http().get(`${org.base}/approval-policies`).set(viewer.auth).expect(200)).body;
    expect(all.map((x: { documentKind: string; isActive: boolean }) => `${x.documentKind}:${x.isActive}`)).toEqual(['INVOICE:false', 'CREDIT_NOTE:false', 'BILL:true', 'VENDOR_CREDIT:false']);
  });

  it('lets bills under the threshold post directly', async () => {
    const small = (await bill(accountant, '4999.99').expect(201)).body;
    expect((await ctx.http().get(`${org.base}/approvals/for-document/${small.id}`).set(accountant.auth).expect(200)).body).toMatchObject({ required: false, readyToPost: true });
    await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: small.id }).expect(422);
    await ctx.http().post(`${org.base}/purchases/documents/${small.id}/post`).set(owner.auth).send({}).expect(200);
  });

  it('blocks posting a covered bill until someone else approves it', async () => {
    const b = (await bill(accountant, '12000.00').expect(201)).body;
    expect((await ctx.http().get(`${org.base}/approvals/for-document/${b.id}`).set(accountant.auth).expect(200)).body).toMatchObject({ required: true, readyToPost: false, policy: { minAmount: '5000.00' } });
    expect((await ctx.http().post(`${org.base}/purchases/documents/${b.id}/post`).set(owner.auth).send({}).expect(409)).body.error).toBe('APPROVAL_REQUIRED');
    // Creating and posting in one step is blocked too.
    expect((await bill(owner, '6000.00', true).expect(409)).body.error).toBe('APPROVAL_REQUIRED');

    const r = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: b.id, note: 'October supplies' }).expect(201)).body;
    expect(r).toMatchObject({ status: 'PENDING', total: '12000.00', contactName: 'Synthetic Supplies', requestedBy: 'Accountant', ownWork: true, canApprove: false });
    await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: b.id }).expect(409);
    // Accountants cannot decide; viewers cannot submit.
    await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(accountant.auth).send({}).expect(403);
    await ctx.http().post(`${org.base}/approvals`).set(viewer.auth).send({ documentId: b.id }).expect(403);

    const inbox = (await ctx.http().get(`${org.base}/approvals?status=PENDING`).set(approver.auth).expect(200)).body;
    expect(inbox.items.find((x: { id: string }) => x.id === r.id)).toMatchObject({ canApprove: true, ownWork: false });

    const res = (await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(approver.auth).send({ note: 'OK', post: true }).expect(200)).body;
    expect(res).toMatchObject({ posted: true, approval: { status: 'APPROVED', decidedBy: 'Approver', decisionNote: 'OK' }, document: { status: 'POSTED' } });
    await ctx.http().post(`${org.base}/approvals/${r.id}/reject`).set(approver.auth).send({ note: 'Too late' }).expect(409);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=approval_request&entityId=${r.id}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit).map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['approval.requested', 'approval.approved']));
  });

  it('refuses an approval from the person who prepared the bill', async () => {
    const b = (await bill(owner, '7000.00').expect(201)).body;
    const r = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: b.id }).expect(201)).body;
    // The owner wrote the draft, so the owner cannot approve it even though the accountant submitted it.
    expect((await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(owner.auth).send({}).expect(403)).body.error).toBe('SAME_PERSON');
    // The database refuses the same thing if the service is bypassed.
    await expect(
      sqlWrite(ctx, `UPDATE approval_requests SET status = 'APPROVED', decided_by_id = '${owner.id}', decided_at = now() WHERE id = '${r.id}'`),
    ).rejects.toThrow(/someone other than/);
    // With the rule switched off, the author may approve their own bill.
    await ctx.http().put(`${org.base}/approval-policies/BILL`).set(owner.auth).send({ minAmount: '5000', requireDifferentApprover: false }).expect(200);
    await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(owner.auth).send({ post: true }).expect(200);
    await ctx.http().put(`${org.base}/approval-policies/BILL`).set(owner.auth).send({ minAmount: '5000', requireDifferentApprover: true }).expect(200);
  });

  it('cancels an approval when the draft changes, so only what was approved can post', async () => {
    const b = (await bill(accountant, '8000.00').expect(201)).body;
    const r = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: b.id }).expect(201)).body;
    await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(approver.auth).send({}).expect(200);
    expect((await ctx.http().get(`${org.base}/approvals/for-document/${b.id}`).set(accountant.auth).expect(200)).body.readyToPost).toBe(true);
    await ctx
      .http()
      .put(`${org.base}/purchases/documents/${b.id}`)
      .set(accountant.auth)
      .send({ kind: 'BILL', contactId: vendorId, issueDate: today(), reference: 'SYN-8000', lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '80000.00' }] })
      .expect(200);
    const state = (await ctx.http().get(`${org.base}/approvals/for-document/${b.id}`).set(accountant.auth).expect(200)).body;
    expect(state.readyToPost).toBe(false);
    expect(state.requests[0]).toMatchObject({ status: 'CANCELLED', decisionNote: 'Cancelled because the draft was changed' });
    expect((await ctx.http().post(`${org.base}/purchases/documents/${b.id}/post`).set(owner.auth).send({}).expect(409)).body.error).toBe('APPROVAL_REQUIRED');
    // Even a direct status change in the database cannot post it.
    await expect(sqlWrite(ctx, `UPDATE documents SET status = 'POSTED' WHERE id = '${b.id}'`)).rejects.toThrow(/needs an approval/);
  });

  it('rejects with a reason, lets the preparer withdraw, and keeps the history after a draft is deleted', async () => {
    const b = (await bill(accountant, '9000.00').expect(201)).body;
    const r1 = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: b.id }).expect(201)).body;
    await ctx.http().post(`${org.base}/approvals/${r1.id}/reject`).set(approver.auth).send({}).expect(400);
    expect((await ctx.http().post(`${org.base}/approvals/${r1.id}/reject`).set(approver.auth).send({ note: 'Missing the receipt' }).expect(200)).body).toMatchObject({ status: 'REJECTED', decisionNote: 'Missing the receipt' });
    const r2 = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: b.id }).expect(201)).body;
    await ctx.http().post(`${org.base}/approvals/${r2.id}/withdraw`).set(viewer.auth).expect(403);
    expect((await ctx.http().post(`${org.base}/approvals/${r2.id}/withdraw`).set(accountant.auth).expect(200)).body.status).toBe('CANCELLED');
    await ctx.http().delete(`${org.base}/purchases/documents/${b.id}`).set(accountant.auth).expect((res) => expect([200, 204]).toContain(res.status));
    const rows = await ctx.prisma.approvalRequest.findMany({ where: { id: { in: [r1.id, r2.id] } } });
    expect(rows.map((x) => [x.status, x.documentId, x.total.toFixed(2)])).toEqual(
      expect.arrayContaining([
        ['REJECTED', null, '9000.00'],
        ['CANCELLED', null, '9000.00'],
      ]),
    );
    await expect(sqlWrite(ctx, `DELETE FROM approval_requests WHERE id = '${r1.id}'`)).rejects.toThrow(/cannot be deleted/);
  });

  it('reports a posting problem after approving instead of undoing the approval', async () => {
    await ctx.http().put(`${org.base}/approval-policies/INVOICE`).set(owner.auth).send({ minAmount: '0' }).expect(200);
    await ctx.http().patch(`${org.base}/contacts/${customerId}`).set(owner.auth).send({ creditLimit: '100.00' }).expect(200);
    const inv = (
      await ctx
        .http()
        .post(`${org.base}/sales/documents`)
        .set(accountant.auth)
        .send({ kind: 'INVOICE', contactId: customerId, issueDate: today(), lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '500.00' }] })
        .expect(201)
    ).body;
    const r = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: inv.id }).expect(201)).body;
    const res = (await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(approver.auth).send({ post: true }).expect(200)).body;
    expect(res).toMatchObject({ posted: false, approval: { status: 'APPROVED' }, postError: { error: 'CREDIT_LIMIT_EXCEEDED' } });
    await ctx.http().post(`${org.base}/sales/documents/${inv.id}/post`).set(approver.auth).send({ overrideCreditLimit: true }).expect(200);
    // An approver without purchases.manage still sees sales and purchases requests; a viewer sees them but cannot approve.
    const seen = (await ctx.http().get(`${org.base}/approvals`).set(viewer.auth).expect(200)).body;
    expect(seen.items.every((x: { canApprove: boolean }) => !x.canApprove)).toBe(true);
  });
});

describe('two-level approvals', () => {
  let second: TestUser;
  it('sets a second approval level above an amount', async () => {
    second = await registerUser(ctx, 'Second Approver');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: second.email, role: 'APPROVER' }).expect(201);
    expect((await ctx.http().put(`${org.base}/approval-policies/BILL`).set(owner.auth).send({ minAmount: '5000', secondApprovalFrom: '1000' }).expect(422)).body.message).toMatch(/second approval/);
    const p = (await ctx.http().put(`${org.base}/approval-policies/BILL`).set(owner.auth).send({ minAmount: '5000', secondApprovalFrom: '50000', secondApproverSenior: true }).expect(200)).body;
    expect(p).toMatchObject({ minAmount: '5000.00', secondApprovalFrom: '50000.00', secondApproverSenior: true });
  });

  it('needs two different approvers, the second an owner or admin, before a large bill posts', async () => {
    const b = (await bill(accountant, '60000.00').expect(201)).body;
    expect((await ctx.http().get(`${org.base}/approvals/for-document/${b.id}`).set(accountant.auth).expect(200)).body.policy).toMatchObject({ approvalsNeeded: 2 });
    const r = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: b.id }).expect(201)).body;
    expect(r).toMatchObject({ status: 'PENDING', approvalsNeeded: 2, approvals: [] });

    const first = (await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(approver.auth).send({ note: 'Prices match the PO', post: true }).expect(200)).body;
    expect(first).toMatchObject({ posted: false, approval: { status: 'PENDING', approvals: [{ by: 'Approver', note: 'Prices match the PO' }], decidedBy: null } });
    expect((await ctx.http().post(`${org.base}/purchases/documents/${b.id}/post`).set(owner.auth).send({}).expect(409)).body.error).toBe('APPROVAL_REQUIRED');
    expect((await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(approver.auth).send({}).expect(403)).body.error).toBe('ALREADY_APPROVED_BY_YOU');
    expect((await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(second.auth).send({}).expect(403)).body.error).toBe('SENIOR_APPROVER_NEEDED');
    const mine = (await ctx.http().get(`${org.base}/approvals?status=PENDING`).set(approver.auth).expect(200)).body.items.find((x: { id: string }) => x.id === r.id);
    expect(mine).toMatchObject({ canApprove: false, waitingFor: 'ANOTHER_APPROVER' });
    const theirs = (await ctx.http().get(`${org.base}/approvals?status=PENDING`).set(second.auth).expect(200)).body.items.find((x: { id: string }) => x.id === r.id);
    expect(theirs).toMatchObject({ canApprove: false, waitingFor: 'OWNER_OR_ADMIN' });
    expect((await ctx.http().get(`${org.base}/approvals?status=PENDING`).set(owner.auth).expect(200)).body.items.find((x: { id: string }) => x.id === r.id)).toMatchObject({ canApprove: true, waitingFor: null });

    const done = (await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(owner.auth).send({ note: 'Second check', post: true }).expect(200)).body;
    expect(done).toMatchObject({ posted: true, approval: { status: 'APPROVED', decidedBy: 'Owner', decisionNote: 'Second check' }, document: { status: 'POSTED' } });
    expect(done.approval.approvals.map((a: { by: string }) => a.by)).toEqual(['Approver', 'Owner']);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=approval_request&entityId=${r.id}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit).map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['approval.requested', 'approval.first_approved', 'approval.approved']));
  });

  it('keeps one approval below the second level, and rejecting after the first approval ends the request', async () => {
    const small = (await bill(accountant, '20000.00').expect(201)).body;
    const r1 = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: small.id }).expect(201)).body;
    expect(r1.approvalsNeeded).toBe(1);
    expect((await ctx.http().post(`${org.base}/approvals/${r1.id}/approve`).set(second.auth).send({ post: true }).expect(200)).body).toMatchObject({ posted: true, approval: { status: 'APPROVED' } });

    const big = (await bill(accountant, '75000.00').expect(201)).body;
    const r2 = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: big.id }).expect(201)).body;
    await ctx.http().post(`${org.base}/approvals/${r2.id}/approve`).set(second.auth).send({}).expect(200);
    const rej = (await ctx.http().post(`${org.base}/approvals/${r2.id}/reject`).set(owner.auth).send({ note: 'Not budgeted' }).expect(200)).body;
    expect(rej).toMatchObject({ status: 'REJECTED', approvals: [{ by: 'Second Approver' }], waitingFor: null });
  });

  it('raises an alert for an approval left waiting, which clears once decided', async () => {
    const b = (await bill(accountant, '90000.00').expect(201)).body;
    const r = (await ctx.http().post(`${org.base}/approvals`).set(accountant.auth).send({ documentId: b.id, note: 'Quarterly service' }).expect(201)).body;
    await ctx.http().post(`${org.base}/approvals/${r.id}/approve`).set(approver.auth).send({}).expect(200);
    await ctx.db.collection('approval_requests').updateOne({ _id: r.id }, { $set: { requestedAt: new Date(Date.now() - 10 * 86_400_000) } });
    await ctx.http().put(`${org.base}/alert-rules/APPROVAL_WAITING`).set(owner.auth).send({ enabled: true, params: { waitingDays: '3' } }).expect(200);
    const waiting = async () => {
      await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200);
      return (await ctx.http().get(`${org.base}/alerts`).query({ status: 'ACTIVE' }).set(owner.auth).expect(200)).body.alerts.filter((a: { rule: string }) => a.rule === 'APPROVAL_WAITING');
    };
    const [a] = await waiting();
    expect(a).toMatchObject({ severity: 'CRITICAL', title: 'Bill draft for Synthetic Supplies waiting 10 days for approval' });
    expect(a.evidence.facts).toEqual(expect.arrayContaining([{ label: 'Approvals', value: '1 of 2 approvals (Approver)' }, { label: 'Submitted by', value: 'Accountant' }]));
    expect(a.evidence.links[0]).toMatchObject({ kind: 'BILL', id: b.id });
    await ctx.http().post(`${org.base}/approvals/${r.id}/reject`).set(owner.auth).send({ note: 'Not this quarter' }).expect(200);
    expect(await waiting()).toEqual([]);
  });

  it('turns the second level off', async () => {
    const p = (await ctx.http().put(`${org.base}/approval-policies/BILL`).set(owner.auth).send({ minAmount: '5000', secondApprovalFrom: null }).expect(200)).body;
    expect(p).toMatchObject({ secondApprovalFrom: null, secondApproverSenior: false });
  });
});
