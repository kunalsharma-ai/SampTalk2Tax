import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * AR-003 customer onboarding against the real API and database: the organisation's checklist,
 * onboarding started by hand or on its own for new customers, details read from the customer,
 * files attached and ticked off, submitting, a second person approving (setting the credit limit
 * and terms) or rejecting, invoices refused until it is approved, permissions, tenant isolation
 * and the database guards.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let clerk: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const S = () => `${org.base}/sales`;
const draft = async (contactId: string, by = owner) => (await ctx.http().post(`${S()}/documents`).set(by.auth).send({ kind: 'INVOICE', contactId, issueDate: T, dueDate: T, lines: [{ accountId: org.acc['4100'], description: 'Setup', quantity: '1', unitPrice: '1000' }] }).expect(201)).body;
const upload = async (onboardingId: string, name: string) =>
  (await ctx.http().post(`${org.base}/attachments?entityType=CUSTOMER_ONBOARDING&entityId=${onboardingId}&fileName=${encodeURIComponent(name)}`).set(owner.auth).set('content-type', 'application/pdf').send(Buffer.from(`%PDF-1.4\n% ${name}\n`)).expect(201)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Onboarding Owner');
  approver = await registerUser(ctx, 'Credit Approver');
  clerk = await registerUser(ctx, 'Sales Clerk');
  outsider = await registerUser(ctx, 'Onboarding Outsider');
  org = await createOrg(ctx, owner, { name: 'Onboarding Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Onboarding Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: clerk.email, role: 'ACCOUNTANT' }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('customer onboarding', () => {
  let oid: string;
  let customer: { id: string; name: string };

  it('has a default checklist the owner can change, and is off until switched on', async () => {
    const s = (await ctx.http().get(`${S()}/onboarding-settings`).set(owner.auth).expect(200)).body;
    expect(s.required).toBe(false);
    expect(s.requirements.map((r: { needsFile: boolean }) => r.needsFile)).toEqual([true, true, false]);
    await ctx.http().put(`${S()}/onboarding-settings`).set(clerk.auth).send({ required: true, requirements: [] }).expect(403);
    const dup = await ctx.http().put(`${S()}/onboarding-settings`).set(owner.auth).send({ required: true, requirements: [{ label: 'KYC', needsFile: true }, { label: 'kyc', needsFile: false }] }).expect(422);
    expect(dup.body.message).toBe('Two checklist items have the same description');
    const saved = (await ctx.http().put(`${S()}/onboarding-settings`).set(owner.auth).send({ required: false, requirements: [{ id: s.requirements[0].id, label: 'KYC documents', needsFile: true }, { label: 'Credit check done', needsFile: false }] }).expect(200)).body;
    expect(saved.requirements.map((r: { label: string }) => r.label)).toEqual(['KYC documents', 'Credit check done']);
    expect(saved.requirements[0].id).toBe(s.requirements[0].id);

    // While off, a new customer has no onboarding and can be invoiced.
    const free = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Walk-in Buyer', isCustomer: true }).expect(201)).body;
    expect((await ctx.http().get(`${S()}/customers/${free.id}/onboarding`).set(owner.auth).expect(200)).body).toMatchObject({ onboarding: null, can: { start: true } });
    const d = await draft(free.id);
    await ctx.http().post(`${S()}/documents/${d.id}/post`).set(owner.auth).send({}).expect(200);
  });

  it('starts on its own for customers added while it is required, and blocks their invoices', async () => {
    await ctx.http().put(`${S()}/onboarding-settings`).set(owner.auth).send({ required: true, requirements: [{ label: 'KYC documents', needsFile: true }, { label: 'Credit check done', needsFile: false }] }).expect(200);
    customer = (await ctx.http().post(`${org.base}/contacts`).set(clerk.auth).send({ name: 'Bharat Engineering', isCustomer: true }).expect(201)).body;
    const got = (await ctx.http().get(`${S()}/customers/${customer.id}/onboarding`).set(clerk.auth).expect(200)).body;
    expect(got.onboarding).toMatchObject({ status: 'OPEN', progress: 0 });
    expect(got.onboarding.checks.map((c: { label: string }) => c.label)).toEqual(['KYC documents', 'Credit check done']);
    expect(got.onboarding.details.map((d: { key: string; done: boolean }) => [d.key, d.done])).toEqual([['EMAIL', false], ['ADDRESS', false], ['TAX_ID', false], ['CREDIT_TERMS', false]]);
    oid = got.onboarding.id;
    const d = await draft(customer.id, clerk);
    const refused = await ctx.http().post(`${S()}/documents/${d.id}/post`).set(owner.auth).send({}).expect(409);
    expect(refused.body).toMatchObject({ error: 'ONBOARDING_INCOMPLETE', message: "Bharat Engineering's customer onboarding is not finished. Invoices to them post once it is approved." });
    // A contact that becomes a customer starts one too; a vendor alone does not.
    const v = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Supplier Turned Buyer', isVendor: true }).expect(201)).body;
    expect((await ctx.http().get(`${S()}/customers/${v.id}/onboarding`).set(owner.auth).expect(200)).body.onboarding).toBeNull();
    await ctx.http().patch(`${org.base}/contacts/${v.id}`).set(owner.auth).send({ isCustomer: true }).expect(200);
    expect((await ctx.http().get(`${S()}/customers/${v.id}/onboarding`).set(owner.auth).expect(200)).body.onboarding.status).toBe('OPEN');
    // Starting one by hand for a customer that has one is refused.
    expect((await ctx.http().post(`${S()}/customers/${customer.id}/onboarding`).set(owner.auth).expect(409)).body.error).toBe('ONBOARDING_EXISTS');
  });

  it('is filled in: details from the customer, proposed terms, files ticked off', async () => {
    const early = await ctx.http().post(`${S()}/onboardings/${oid}/submit`).set(clerk.auth).expect(422);
    expect(early.body.details.issues).toHaveLength(6);
    await ctx.http().patch(`${org.base}/contacts/${customer.id}`).set(clerk.auth).send({ email: 'accounts@bharat.test', address: 'MIDC Bhosari, Pune', pincode: '411026', gstin: '27AAPFU0939F1ZV' }).expect(200);
    expect((await ctx.http().put(`${S()}/onboardings/${oid}`).set(clerk.auth).send({ creditLimit: '-5', paymentTermsDays: 30 }).expect(400)).body.error).toBeTruthy();
    const t = (await ctx.http().put(`${S()}/onboardings/${oid}`).set(clerk.auth).send({ creditLimit: '250000', paymentTermsDays: 45, notes: 'Introduced by the Pune dealer.' }).expect(200)).body;
    expect(t.details.every((d: { done: boolean }) => d.done)).toBe(true);
    const [kyc, credit] = t.checks;
    expect((await ctx.http().put(`${S()}/onboardings/${oid}/checks/${kyc.id}`).set(clerk.auth).send({ done: true }).expect(422)).body.message).toBe('KYC documents: attach the file first');
    const file = await upload(oid, 'incorporation-certificate.pdf');
    // A file of another onboarding cannot be named.
    const otherOnb = (await ctx.http().get(`${S()}/onboardings?status=OPEN`).set(owner.auth).expect(200)).body.onboardings.find((o: { id: string }) => o.id !== oid);
    const stray = await upload(otherOnb.id, 'stray.pdf');
    expect((await ctx.http().put(`${S()}/onboardings/${oid}/checks/${kyc.id}`).set(clerk.auth).send({ done: true, attachmentId: stray.id }).expect(422)).body.message).toBe('Choose a file attached to this onboarding');
    await ctx.http().put(`${S()}/onboardings/${oid}/checks/${kyc.id}`).set(clerk.auth).send({ done: true, attachmentId: file.id }).expect(200);
    const done = (await ctx.http().put(`${S()}/onboardings/${oid}/checks/${credit.id}`).set(clerk.auth).send({ done: true, note: 'Two trade references called.' }).expect(200)).body;
    expect(done).toMatchObject({ progress: 100, issues: [] });
    expect(done.checks[0]).toMatchObject({ done: true, doneBy: 'Sales Clerk', file: { fileName: 'incorporation-certificate.pdf' } });
  });

  it('is submitted, then approved by someone else, which sets the credit limit and terms', async () => {
    const s = (await ctx.http().post(`${S()}/onboardings/${oid}/submit`).set(clerk.auth).expect(200)).body;
    expect(s).toMatchObject({ status: 'SUBMITTED', submittedBy: 'Sales Clerk', submitterMayDecide: false });
    // Nothing changes while it waits, files included.
    expect((await ctx.http().put(`${S()}/onboardings/${oid}`).set(clerk.auth).send({ creditLimit: '900000' }).expect(409)).body.error).toBe('ONBOARDING_NOT_OPEN');
    expect((await ctx.http().post(`${org.base}/attachments?entityType=CUSTOMER_ONBOARDING&entityId=${oid}&fileName=late.pdf`).set(owner.auth).set('content-type', 'application/pdf').send(Buffer.from('%PDF-1.4\n')).expect(409)).body.error).toBe('ONBOARDING_NOT_OPEN');
    await ctx.http().post(`${S()}/onboardings/${oid}/decide`).set(clerk.auth).send({ approve: true }).expect(403);
    expect((await ctx.http().post(`${S()}/onboardings/${oid}/decide`).set(approver.auth).send({ approve: false }).expect(422)).body.message).toBe('Give the reason for rejecting it');
    const r = (await ctx.http().post(`${S()}/onboardings/${oid}/decide`).set(approver.auth).send({ approve: false, note: 'Credit limit too high for a new account; start at 1,00,000.' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'REJECTED', decidedBy: 'Credit Approver' });
    await ctx.http().post(`${S()}/onboardings/${oid}/reopen`).set(clerk.auth).expect(200);
    await ctx.http().put(`${S()}/onboardings/${oid}`).set(clerk.auth).send({ creditLimit: '100000', paymentTermsDays: 30 }).expect(200);
    await ctx.http().post(`${S()}/onboardings/${oid}/submit`).set(clerk.auth).expect(200);
    const a = (await ctx.http().post(`${S()}/onboardings/${oid}/decide`).set(approver.auth).send({ approve: true, note: 'Approved at 1 lakh.' }).expect(200)).body;
    expect(a).toMatchObject({ status: 'APPROVED', selfApproved: false, contact: { creditLimit: '100000.00', paymentTermsDays: 30 } });
    // Now the invoice posts.
    const d = await draft(customer.id);
    await ctx.http().post(`${S()}/documents/${d.id}/post`).set(owner.auth).send({}).expect(200);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'customer_onboarding', entityId: oid }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((x) => x.action)).toContain('customer_onboarding.approved');
  });

  it('lets the only approver decide alone, recorded as self-approved', async () => {
    const solo = await createOrg(ctx, outsider, { name: 'Solo Trader' });
    const c = (await ctx.http().post(`/v1/orgs/${solo.orgId}/contacts`).set(outsider.auth).send({ name: 'Solo Customer', email: 'x@y.test', address: 'Nashik', pincode: '422001', pan: 'ABCPE1234F', isCustomer: true }).expect(201)).body;
    const base = `/v1/orgs/${solo.orgId}/sales`;
    await ctx.http().put(`${base}/onboarding-settings`).set(outsider.auth).send({ required: false, requirements: [] }).expect(200);
    const o = (await ctx.http().post(`${base}/customers/${c.id}/onboarding`).set(outsider.auth).expect(201)).body;
    expect(o.checks).toEqual([]);
    await ctx.http().put(`${base}/onboardings/${o.id}`).set(outsider.auth).send({ creditLimit: '0', paymentTermsDays: 0 }).expect(200);
    expect((await ctx.http().post(`${base}/onboardings/${o.id}/submit`).set(outsider.auth).expect(200)).body.submitterMayDecide).toBe(true);
    const a = (await ctx.http().post(`${base}/onboardings/${o.id}/decide`).set(outsider.auth).send({ approve: true }).expect(200)).body;
    expect(a).toMatchObject({ status: 'APPROVED', selfApproved: true });
  });

  it('needs a second person when there is one, and stays private to the organisation', async () => {
    const c = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Second Person Ltd', email: 'a@b.test', address: 'Pune', pincode: '411001', pan: 'ABCPE1234F', isCustomer: true }).expect(201)).body;
    const o = (await ctx.http().get(`${S()}/customers/${c.id}/onboarding`).set(owner.auth).expect(200)).body.onboarding;
    await ctx.http().put(`${S()}/onboardings/${o.id}`).set(owner.auth).send({ creditLimit: '0', paymentTermsDays: 0 }).expect(200);
    const f = await upload(o.id, 'kyc.pdf');
    for (const k of o.checks) await ctx.http().put(`${S()}/onboardings/${o.id}/checks/${k.id}`).set(owner.auth).send({ done: true, attachmentId: k.needsFile ? f.id : null }).expect(200);
    await ctx.http().post(`${S()}/onboardings/${o.id}/submit`).set(owner.auth).expect(200);
    expect((await ctx.http().post(`${S()}/onboardings/${o.id}/decide`).set(owner.auth).send({ approve: true }).expect(409)).body.error).toBe('SAME_PERSON');
    await ctx.http().post(`${S()}/onboardings/${o.id}/withdraw`).set(owner.auth).expect(200);

    const list = (await ctx.http().get(`${S()}/onboardings`).set(clerk.auth).expect(200)).body;
    expect(list.required).toBe(true);
    expect(list.counts).toMatchObject({ APPROVED: 1 });
    expect(list.onboardings.find((x: { id: string }) => x.id === oid)).toMatchObject({ status: 'APPROVED', progress: 100, creditLimit: '100000.00' });
    await ctx.http().get(`${S()}/onboardings/${oid}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/sales/onboardings/${oid}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/sales/onboardings`).set(outsider.auth).expect(200)).body.onboardings).toEqual([]);
  });

  it('is guarded in the database: approved is final, checks change only while open', async () => {
    await expect(raw(`UPDATE customer_onboardings SET credit_limit = 1 WHERE id = '${oid}'`)).rejects.toThrow(/customer onboarding is approved/);
    await expect(raw(`DELETE FROM customer_onboardings WHERE id = '${oid}'`)).rejects.toThrow(/cannot be deleted/);
    await expect(raw(`UPDATE customer_onboarding_checks SET done = false, done_by_id = NULL, done_at = NULL WHERE onboarding_id = '${oid}'`)).rejects.toThrow(/not open/);
    const open = await ctx.prisma.customerOnboarding.findFirstOrThrow({ where: { orgId: org.orgId, status: 'OPEN' } });
    await expect(raw(`UPDATE customer_onboardings SET status = 'APPROVED', decided_by_id = created_by_id, decided_at = now() WHERE id = '${open.id}'`)).rejects.toThrow();
  });
});
