import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mirrorRows } from '../src/common/prisma.service';
import { tenantStorage } from '../src/common/tenant-context';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AP-014 payment batches and AP-027 vendor bank-detail control against the real API and database:
 * bank details saved, changed (history kept, verification cleared) and verified by a second person;
 * a batch prepared, refused for approval by its preparer or while details are unverified, approved,
 * its bank file, payments recorded (one per vendor, bills settled); a bill in one open batch only;
 * a bill paid in the meantime; cancelling; permissions, guards and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
let cedar: string;
let granite: string;
const bills: Record<string, { id: string; number: string }> = {};
const raw = (sql: string) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql);
  });
const bill = async (vendor: string, amount: string) =>
  (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, post: true, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: amount }] }).expect(201)).body as { id: string; number: string };
const B = () => `${org.base}/purchases/payment-batches`;
const bank = (c: string) => `/v1/orgs/${org.orgId}/contacts/${c}/bank-details`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Batch Owner');
  approver = await registerUser(ctx, 'Batch Approver');
  accountant = await registerUser(ctx, 'Batch Accountant');
  viewer = await registerUser(ctx, 'Batch Viewer');
  outsider = await registerUser(ctx, 'Batch Outsider');
  org = await createOrg(ctx, owner, { name: 'Batch Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Batches' });
  for (const [u, role] of [[approver, 'APPROVER'], [accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  cedar = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Cedar Hardware', isVendor: true, email: 'ap@cedar.test' }).expect(201)).body.id;
  granite = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Granite Supplies', isVendor: true }).expect(201)).body.id;
  bills.c1 = await bill(cedar, '11800');
  bills.c2 = await bill(cedar, '5000');
  bills.g1 = await bill(granite, '20000');
});
afterAll(async () => {
  await ctx.app.close();
});

describe('vendor bank details', () => {
  it('are saved, masked, and verified by a second person', async () => {
    expect((await ctx.http().put(bank(cedar)).set(accountant.auth).send({ accountName: 'Cedar Hardware LLP', accountNumber: '50100123', ifsc: 'HDFC1001234' }).expect(422)).body.error).toBe('BANK_DETAILS_INVALID');
    await ctx.http().put(bank(cedar)).set(viewer.auth).send({ accountName: 'x', accountNumber: '50100123', ifsc: 'HDFC0001234' }).expect(403);
    const d = (await ctx.http().put(bank(cedar)).set(accountant.auth).send({ accountName: 'Cedar Hardware LLP', accountNumber: '5010 0123 4567', ifsc: 'hdfc0001234', bankName: 'HDFC Bank' }).expect(200)).body;
    expect(d.details).toMatchObject({ accountName: 'Cedar Hardware LLP', accountNumberMasked: 'XXXXXXXX4567', ifsc: 'HDFC0001234', verified: false, changedBy: 'Batch Accountant' });
    expect(JSON.stringify(d)).not.toContain('501001234567');
    await ctx.http().post(`${bank(cedar)}/verify`).set(accountant.auth).send({ note: 'Called them' }).expect(403);
    const v = (await ctx.http().post(`${bank(cedar)}/verify`).set(approver.auth).send({ note: 'Called the number on their letterhead' }).expect(200)).body;
    expect(v.details).toMatchObject({ verified: true, verifiedBy: 'Batch Approver', verificationNote: 'Called the number on their letterhead' });
    // The owner changed Granite's details and may not verify them while an approver exists.
    await ctx.http().put(bank(granite)).set(owner.auth).send({ accountName: 'Granite Supplies Pvt Ltd', accountNumber: '000123456789', ifsc: 'ICIC0000999' }).expect(200);
    expect((await ctx.http().post(`${bank(granite)}/verify`).set(owner.auth).send({ note: 'Self check' }).expect(409)).body.error).toBe('SAME_PERSON');
  });
});

describe('payment batches', () => {
  let id: string;
  it('are prepared from payable bills', async () => {
    const payable = (await ctx.http().get(`${B()}/payable-bills`).set(viewer.auth).expect(200)).body;
    expect(payable.map((b: { number: string }) => b.number).sort()).toEqual([bills.c1.number, bills.c2.number, bills.g1.number].sort());
    await ctx.http().post(B()).set(viewer.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, items: [] }).expect(403);
    expect((await ctx.http().post(B()).set(accountant.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, items: [{ documentId: bills.c1.id, amount: '11800.01' }] }).expect(422)).body.error).toBe('MORE_THAN_DUE');
    const b = (await ctx.http().post(B()).set(accountant.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, memo: 'Friday run', items: [{ documentId: bills.c1.id }, { documentId: bills.c2.id, amount: '3000' }, { documentId: bills.g1.id }] }).expect(201)).body;
    id = b.id;
    expect(b).toMatchObject({ reference: 'PB-0001', status: 'DRAFT', total: '34800.00', createdBy: 'Batch Accountant' });
    expect(b.vendors.map((v: { name: string; amount: string; bills: number }) => [v.name, v.amount, v.bills])).toEqual([['Cedar Hardware', '14800.00', 2], ['Granite Supplies', '20000.00', 1]]);
    expect(b.issues.map((i: { issue: string }) => i.issue)).toEqual(["Granite Supplies's bank details were changed and are not verified yet"]);
    // A bill is in one open batch at a time.
    expect((await ctx.http().post(B()).set(accountant.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, items: [{ documentId: bills.g1.id }] }).expect(409)).body.error).toBe('IN_ANOTHER_BATCH');
    expect((await ctx.http().get(`${B()}/payable-bills`).set(viewer.auth).expect(200)).body.find((x: { id: string }) => x.id === bills.g1.id).inBatch).toBe('PB-0001');
  });

  it('are approved by someone other than the preparer, once every vendor is verified', async () => {
    await ctx.http().post(`${B()}/${id}/approve`).set(accountant.auth).expect(403);
    expect((await ctx.http().post(`${B()}/${id}/approve`).set(approver.auth).expect(409)).body.error).toBe('BATCH_NOT_PAYABLE');
    await ctx.http().post(`${bank(granite)}/verify`).set(approver.auth).send({ note: 'Confirmed by phone with their accounts head' }).expect(200);
    expect((await ctx.http().post(`${B()}/${id}/payment-file`).set(accountant.auth).expect(409)).body.error).toBe('NOT_APPROVED');
    const a = (await ctx.http().post(`${B()}/${id}/approve`).set(approver.auth).expect(200)).body;
    expect(a).toMatchObject({ status: 'APPROVED', approvedBy: 'Batch Approver', selfApproved: false, issues: [] });
    expect((await ctx.http().patch(`${B()}/${id}`).set(accountant.auth).send({ memo: 'x' }).expect(409)).body.error).toBe('NOT_DRAFT');
  });

  it('give the bank file, and record one payment per vendor', async () => {
    const f = await ctx.http().post(`${B()}/${id}/payment-file`).set(accountant.auth).expect(200);
    expect(f.headers['content-type']).toMatch(/text\/csv/);
    const lines = f.text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`Cedar Hardware LLP,501001234567,HDFC0001234,14800.00,INR,PB-0001 2 bills,ap@cedar.test,Cedar Hardware`);
    expect(lines[2]).toContain(`Granite Supplies Pvt Ltd,000123456789,ICIC0000999,20000.00,INR,PB-0001 ${bills.g1.number},,Granite Supplies`);

    // A change of bank details after approval stops the payments until verified again.
    await ctx.http().put(bank(cedar)).set(accountant.auth).send({ accountName: 'Cedar Hardware LLP', accountNumber: '999988887777', ifsc: 'HDFC0001234' }).expect(200);
    expect((await ctx.http().post(`${B()}/${id}/paid`).set(accountant.auth).expect(409)).body.message).toMatch(/Cedar Hardware's bank details were changed/);
    await ctx.http().post(`${bank(cedar)}/verify`).set(approver.auth).send({ note: 'Bank letter checked and called back' }).expect(200);
    const hist = (await ctx.http().get(bank(cedar)).set(viewer.auth).expect(200)).body.history;
    expect(hist.map((h: { before: string | null; after: string }) => [h.before, h.after])).toEqual([
      ['Cedar Hardware LLP · XXXXXXXX4567 · HDFC0001234', 'Cedar Hardware LLP · XXXXXXXX7777 · HDFC0001234'],
      [null, 'Cedar Hardware LLP · XXXXXXXX4567 · HDFC0001234'],
    ]);

    await ctx.http().post(`${B()}/${id}/paid`).set(approver.auth).expect(403);
    const p = (await ctx.http().post(`${B()}/${id}/paid`).set(accountant.auth).expect(200)).body;
    expect(p.status).toBe('PAID');
    const pays = new Set(p.items.map((i: { payment: { number: string } }) => i.payment.number));
    expect(pays.size).toBe(2);
    const doc = async (d: string) => (await ctx.http().get(`${org.base}/purchases/documents/${d}`).set(owner.auth).expect(200)).body;
    expect((await doc(bills.c1.id)).amountDue).toBe('0.00');
    expect((await doc(bills.c2.id)).amountDue).toBe('2000.00');
    expect((await doc(bills.g1.id)).amountDue).toBe('0.00');
    const payments = (await ctx.http().get(`${org.base}/purchases/payments?contactId=${cedar}`).set(owner.auth).expect(200)).body;
    const list = Array.isArray(payments) ? payments : payments.items;
    expect(list[0]).toMatchObject({ amount: '14800.00', reference: 'PB-0001' });
    expect((await ctx.http().post(`${B()}/${id}/paid`).set(accountant.auth).expect(409)).body.error).toBe('NOT_APPROVED');
    expect((await ctx.http().post(`${B()}/${id}/cancel`).set(accountant.auth).send({ reason: 'Too late' }).expect(409)).body.error).toBe('FINAL');
  });

  it('refuse a bill paid in the meantime, and are cancelled', async () => {
    const b2 = (await ctx.http().post(B()).set(accountant.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, items: [{ documentId: bills.c2.id }] }).expect(201)).body;
    expect(b2).toMatchObject({ reference: 'PB-0002', total: '2000.00' });
    // Paid by hand before approval.
    await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: cedar, date: T, bankAccountId: org.acc['1120'], amount: '500', allocations: [{ documentId: bills.c2.id, amount: '500' }] }).expect(201);
    expect((await ctx.http().post(`${B()}/${b2.id}/approve`).set(approver.auth).expect(409)).body.message).toMatch(/now has 1500.00 INR left to pay/);
    const c = (await ctx.http().post(`${B()}/${b2.id}/cancel`).set(accountant.auth).send({ reason: 'Paid part by cheque' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'Paid part by cheque' });
    // The bill is free for a new batch; a draft can be deleted.
    const b3 = (await ctx.http().post(B()).set(accountant.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, items: [{ documentId: bills.c2.id }] }).expect(201)).body;
    expect(b3.total).toBe('1500.00');
    await ctx.http().delete(`${B()}/${b3.id}`).set(accountant.auth).expect(204);
    expect((await ctx.http().get(B()).set(viewer.auth).expect(200)).body.batches.map((x: { reference: string; status: string }) => [x.reference, x.status])).toEqual([['PB-0002', 'CANCELLED'], ['PB-0001', 'PAID']]);
  });

  it('let the only approver approve their own batch, marked as such', async () => {
    const solo = await registerUser(ctx, 'Solo Owner');
    const so = await createOrg(ctx, solo, { name: 'Solo Traders' });
    const v = (await ctx.http().post(`${so.base}/contacts`).set(solo.auth).send({ name: 'Solo Vendor', isVendor: true }).expect(201)).body.id;
    await ctx.http().put(`/v1/orgs/${so.orgId}/contacts/${v}/bank-details`).set(solo.auth).send({ accountName: 'Solo Vendor', accountNumber: '123456789', ifsc: 'SBIN0000001' }).expect(200);
    await ctx.http().post(`/v1/orgs/${so.orgId}/contacts/${v}/bank-details/verify`).set(solo.auth).send({ note: 'Only member; checked the cancelled cheque' }).expect(200);
    const sb = (await ctx.http().post(`${so.base}/purchases/documents`).set(solo.auth).send({ kind: 'BILL', contactId: v, issueDate: T, post: true, lines: [{ accountId: so.acc['6600'], quantity: '1', unitPrice: '100' }] }).expect(201)).body;
    const b = (await ctx.http().post(`${so.base}/purchases/payment-batches`).set(solo.auth).send({ bankAccountId: so.acc['1120'], paymentDate: T, items: [{ documentId: sb.id }] }).expect(201)).body;
    expect((await ctx.http().post(`${so.base}/purchases/payment-batches/${b.id}/approve`).set(solo.auth).expect(200)).body).toMatchObject({ status: 'APPROVED', selfApproved: true });
  });
});

describe('records', () => {
  it('are guarded in the database', async () => {
    await expect(raw(`DELETE FROM vendor_bank_detail_changes WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/append-only/);
    await expect(raw(`DELETE FROM vendor_bank_details WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be deleted/);
    await expect(raw(`UPDATE payment_batches SET memo = 'x' WHERE org_id = '${org.orgId}' AND status = 'PAID'`)).rejects.toThrow(/final/);
    await expect(raw(`UPDATE payment_batch_items SET amount = 1 WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/only while the batch is a draft/);
    // Changing the details by any route clears the verification.
    await raw(`UPDATE vendor_bank_details SET account_number = '111122223333' WHERE contact_id = '${granite}'`);
    // Written past the API, so MongoDB is brought in step by hand.
    await tenantStorage.run({ bypass: true }, () => mirrorRows(ctx.prisma, 'VendorBankDetails', { contactId: granite }));
    expect((await ctx.http().get(bank(granite)).set(viewer.auth).expect(200)).body.details.verified).toBe(false);
  });

  it('keep each organisation to its own', async () => {
    await ctx.http().get(B()).set(outsider.auth).expect(404);
    await ctx.http().get(bank(cedar)).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/purchases/payment-batches`).set(outsider.auth).expect(200)).body.batches).toEqual([]);
    await ctx.http().get(`/v1/orgs/${other.orgId}/contacts/${cedar}/bank-details`).set(outsider.auth).expect(404);
  });
});
