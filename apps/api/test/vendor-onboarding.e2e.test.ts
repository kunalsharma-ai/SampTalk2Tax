import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AP-002 vendor onboarding against the real API and database: the vendor checklist (separate from
 * the customer one), onboarding started for new vendors, verified bank details and payment terms
 * read as checks, a second person approving (setting the payment terms), bills and payments to the
 * vendor refused until then, and a contact that is both customer and vendor with one of each.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

const P = () => `${org.base}/purchases`;
const upload = async (onboardingId: string, name: string, by = owner) =>
  (await ctx.http().post(`${org.base}/attachments?entityType=CUSTOMER_ONBOARDING&entityId=${onboardingId}&fileName=${encodeURIComponent(name)}`).set(by.auth).set('content-type', 'application/pdf').send(Buffer.from(`%PDF-1.4\n% ${name} ${Math.random()}\n`)).expect(201)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Purchases Owner');
  approver = await registerUser(ctx, 'Vendor Approver');
  org = await createOrg(ctx, owner, { name: 'Vendor Onboarding Industries' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('vendor onboarding', () => {
  let vendor: { id: string };
  let oid: string;

  it('has its own checklist and setting, separate from customers', async () => {
    const v = (await ctx.http().get(`${P()}/onboarding-settings`).set(owner.auth).expect(200)).body;
    expect(v.requirements.map((r: { label: string }) => r.label)).toEqual(['GST certificate or PAN card', 'Cancelled cheque or bank letter for the account to pay', 'MSME (Udyam) status checked and recorded']);
    await ctx.http().put(`${P()}/onboarding-settings`).set(owner.auth).send({ required: true, requirements: v.requirements.slice(0, 2).map((r: { id: string; label: string; needsFile: boolean }) => r) }).expect(200);
    const c = (await ctx.http().get(`${org.base}/sales/onboarding-settings`).set(owner.auth).expect(200)).body;
    expect(c.required).toBe(false);
    expect(c.requirements).toHaveLength(3);
  });

  it('starts for new vendors, and their bills and payments wait for approval', async () => {
    vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Shree Steel Suppliers', isVendor: true }).expect(201)).body;
    const got = (await ctx.http().get(`${P()}/vendors/${vendor.id}/onboarding`).set(owner.auth).expect(200)).body;
    expect(got.onboarding).toMatchObject({ party: 'VENDOR', status: 'OPEN' });
    expect(got.onboarding.details.map((d: { key: string }) => d.key)).toEqual(['EMAIL', 'ADDRESS', 'TAX_ID', 'BANK', 'PAYMENT_TERMS']);
    expect(got.onboarding.checks).toHaveLength(2);
    oid = got.onboarding.id;
    // The vendor onboarding is not reachable through the customer routes.
    await ctx.http().get(`${org.base}/sales/onboardings/${oid}`).set(owner.auth).expect(404);
    const bill = (await ctx.http().post(`${P()}/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor.id, issueDate: T, dueDate: T, reference: 'SSS/101', lines: [{ accountId: org.acc['5000'] ?? org.acc['6000'], description: 'Steel', quantity: '1', unitPrice: '10000' }] }).expect(201)).body;
    const refused = await ctx.http().post(`${P()}/documents/${bill.id}/post`).set(owner.auth).send({}).expect(409);
    expect(refused.body.message).toBe("Shree Steel Suppliers's vendor onboarding is not finished. Bills from them post once it is approved.");
    const pay = await ctx.http().post(`${P()}/payments`).set(owner.auth).send({ contactId: vendor.id, date: T, bankAccountId: org.acc['1120'], amount: '500' }).expect(409);
    expect(pay.body.message).toMatch(/They can be paid once it is approved/);
    (globalThis as { billId?: string }).billId = bill.id;
  });

  it('reads verified bank details and payment terms, and refuses a credit limit', async () => {
    expect((await ctx.http().put(`${P()}/onboardings/${oid}`).set(owner.auth).send({ creditLimit: '1000' }).expect(422)).body.message).toBe('A vendor onboarding agrees payment terms only, not a credit limit');
    await ctx.http().patch(`${org.base}/contacts/${vendor.id}`).set(owner.auth).send({ email: 'accounts@shreesteel.test', address: 'Chakan MIDC, Pune', pincode: '410501', pan: 'AAPFU0939F' }).expect(200);
    await ctx.http().put(`${org.base}/contacts/${vendor.id}/bank-details`).set(owner.auth).send({ accountName: 'Shree Steel Suppliers', accountNumber: '123456789012', ifsc: 'SBIN0000001' }).expect(200);
    let d = (await ctx.http().put(`${P()}/onboardings/${oid}`).set(owner.auth).send({ paymentTermsDays: 45 }).expect(200)).body;
    expect(d.details.find((x: { key: string }) => x.key === 'BANK').done).toBe(false);
    await ctx.http().post(`${org.base}/contacts/${vendor.id}/bank-details/verify`).set(approver.auth).send({ note: 'Called the vendor on the number in the PO' }).expect(200);
    for (const k of d.checks) {
      const f = await upload(oid, `${k.label.slice(0, 10)}.pdf`);
      d = (await ctx.http().put(`${P()}/onboardings/${oid}/checks/${k.id}`).set(owner.auth).send({ done: true, attachmentId: f.id }).expect(200)).body;
    }
    expect(d).toMatchObject({ progress: 100, issues: [] });
  });

  it('is approved by a second person, setting the payment terms; then bills post and the vendor can be paid', async () => {
    await ctx.http().post(`${P()}/onboardings/${oid}/submit`).set(owner.auth).expect(200);
    expect((await ctx.http().post(`${P()}/onboardings/${oid}/decide`).set(owner.auth).send({ approve: true }).expect(409)).body.error).toBe('SAME_PERSON');
    const a = (await ctx.http().post(`${P()}/onboardings/${oid}/decide`).set(approver.auth).send({ approve: true }).expect(200)).body;
    expect(a).toMatchObject({ status: 'APPROVED', contact: { paymentTermsDays: 45, creditLimit: null } });
    await ctx.http().post(`${P()}/documents/${(globalThis as { billId?: string }).billId}/post`).set(owner.auth).send({}).expect(200);
    await ctx.http().post(`${P()}/payments`).set(owner.auth).send({ contactId: vendor.id, date: T, bankAccountId: org.acc['1120'], amount: '500' }).expect(201);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'vendor_onboarding', entityId: oid } });
    expect(audit.map((x) => x.action)).toContain('vendor_onboarding.approved');
    const list = (await ctx.http().get(`${P()}/onboardings`).set(owner.auth).expect(200)).body;
    expect(list).toMatchObject({ required: true, counts: { APPROVED: 1 } });
    expect(list.onboardings.find((x: { id: string }) => x.id === oid).progress).toBe(100);
  });

  it('gives a contact that is both customer and vendor one onboarding of each', async () => {
    const both = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Two Way Traders', isVendor: true, isCustomer: true }).expect(201)).body;
    expect((await ctx.http().get(`${P()}/vendors/${both.id}/onboarding`).set(owner.auth).expect(200)).body.onboarding.party).toBe('VENDOR');
    // Customer onboarding is not required here, so none started; it can be started by hand.
    expect((await ctx.http().get(`${org.base}/sales/customers/${both.id}/onboarding`).set(owner.auth).expect(200)).body.onboarding).toBeNull();
    const c = (await ctx.http().post(`${org.base}/sales/customers/${both.id}/onboarding`).set(owner.auth).expect(201)).body;
    expect(c.party).toBe('CUSTOMER');
    expect(c.details.map((d: { key: string }) => d.key)).toContain('CREDIT_TERMS');
  });
});
