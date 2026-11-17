import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * AP-023 international payments against the real API and database: a vendor's bank account abroad
 * (IBAN and SWIFT checked, verified by a second person), an outward remittance against their USD
 * bills with purpose code and the Form 15CA/15CB position, approval by someone else, the remittance
 * instruction for the bank, and the payment recorded at the bank's rate.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let clerk: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let vendor: { id: string };
let bills: { id: string; number: string }[] = [];

const IP = () => `${org.base}/purchases/international-payments`;
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
async function postBill(amount: string, ref: string) {
  const d = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor.id, issueDate: T, dueDate: addDays(T, 30), currency: 'USD', reference: ref, lines: [{ accountId: org.acc['6600'], description: 'Software consultancy', quantity: '1', unitPrice: amount }] }).expect(201)).body;
  return (await ctx.http().post(`${org.base}/purchases/documents/${d.id}/post`).set(owner.auth).send({}).expect(200)).body;
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Remit Owner');
  approver = await registerUser(ctx, 'Remit Approver');
  clerk = await registerUser(ctx, 'Remit Viewer');
  org = await createOrg(ctx, owner, { name: 'Outward Remit Industries' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: clerk.email, role: 'VIEWER' }).expect(201);
  await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: T, rate: '83' }).expect(200);
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Acme Cloud Inc', isVendor: true, address: '1 Market St, San Francisco' }).expect(201)).body;
  bills = [await postBill('4000', 'AC-1001'), await postBill('3000', 'AC-1002')];
});
afterAll(async () => {
  await ctx.app.close();
});

describe('international payments', () => {
  it('takes a bank account abroad, checking the IBAN, SWIFT country and routing code', async () => {
    const B = `${org.base}/contacts/${vendor.id}/bank-details`;
    const bad = (await ctx.http().put(`${B}/international`).set(owner.auth).send({ accountName: 'Acme Cloud Inc', accountNumber: '000123456789', swiftBic: 'CHASUS33', bankCountry: 'US' }).expect(422)).body;
    expect(bad.details.issues).toEqual(['Banks in US also need the ABA routing number (for example 021000021)']);
    expect((await ctx.http().put(`${B}/international`).set(owner.auth).send({ accountName: 'Acme', accountNumber: 'DE88370400440532013000', swiftBic: 'COBADEFF', bankCountry: 'DE' }).expect(422)).body.message).toMatch(/check digits are wrong/);
    const d = (await ctx.http().put(`${B}/international`).set(owner.auth).send({ accountName: 'Acme Cloud Inc', accountNumber: '0001 2345 6789', swiftBic: 'chasus33', bankCountry: 'us', bankName: 'JPMorgan Chase', routingCode: '021000021' }).expect(200)).body;
    expect(d.details).toMatchObject({ kind: 'INTERNATIONAL', ifsc: null, swiftBic: 'CHASUS33', bankCountry: 'US', routingCode: '021000021', accountNumberMasked: 'XXXXXXXX6789', verified: false });
    // The domestic batch file cannot pay them.
    const sched = (await ctx.http().get(`${org.base}/purchases/payment-batches/payable-bills?currency=USD`).set(owner.auth).expect(200)).body;
    expect(sched[0].bank).toMatchObject({ international: true });
  });

  it('prepares a remittance: purpose, Form 15CA part C with a 15CB above ₹5 lakh, and what is missing', async () => {
    await ctx.http().post(IP()).set(clerk.auth).send({}).expect(403);
    const payable = (await ctx.http().get(`${IP()}/payable`).set(owner.auth).expect(200)).body;
    expect(payable.map((b: { number: string }) => b.number).sort()).toEqual(bills.map((b) => b.number).sort());
    expect((await ctx.http().post(IP()).set(owner.auth).send({ contactId: vendor.id, bankAccountId: org.acc['1120'], paymentDate: T, currency: 'INR', items: [{ documentId: bills[0]!.id }] }).expect(422)).body.message).toMatch(/vendor's currency/);
    expect((await ctx.http().post(IP()).set(owner.auth).send({ contactId: vendor.id, bankAccountId: org.acc['1120'], paymentDate: T, currency: 'USD', items: [{ documentId: bills[0]!.id, amount: '4000.01' }] }).expect(422)).body.message).toBe(`${bills[0]!.number} has 4000.00 USD left to pay`);
    let p = (await ctx.http().post(IP()).set(owner.auth).send({ contactId: vendor.id, bankAccountId: org.acc['1120'], paymentDate: T, currency: 'USD', items: bills.map((b) => ({ documentId: b.id })), purposeCode: 'S0802' }).expect(201)).body;
    expect(p).toMatchObject({ reference: 'IP-0001', status: 'DRAFT', amount: '7000.00', estimateRate: '83', estimateInr: '581000.00', purpose: 'Software consultancy and implementation', charges: 'OUR' });
    expect(p.form15).toMatchObject({ part: 'C', needs15cb: true, applies: true });
    expect(p.issues).toEqual([
      "The vendor's international bank details are not verified yet",
      'Enter the acknowledgement number of Form 15CA Part C',
      'Enter the Form 15CB acknowledgement number from the chartered accountant',
    ]);
    // A bill sits in one open payment at a time.
    expect((await ctx.http().post(IP()).set(owner.auth).send({ contactId: vendor.id, bankAccountId: org.acc['1120'], paymentDate: T, currency: 'USD', items: [{ documentId: bills[1]!.id }] }).expect(422)).body.message).toBe(`${bills[1]!.number} is already in IP-0001`);
    // Under ₹5 lakh: Part A, no 15CB.
    const body = { contactId: vendor.id, bankAccountId: org.acc['1120'], paymentDate: T, currency: 'USD', items: [{ documentId: bills[0]!.id }], purposeCode: 'S0802' };
    p = (await ctx.http().put(`${IP()}/${p.id}`).set(owner.auth).send(body).expect(200)).body;
    expect(p.form15).toMatchObject({ part: 'A', needs15cb: false });
    // Not taxable in India: Part D. Imports of goods: no form at all.
    expect((await ctx.http().put(`${IP()}/${p.id}`).set(owner.auth).send({ ...body, taxableInIndia: false }).expect(200)).body.form15.part).toBe('D');
    expect((await ctx.http().put(`${IP()}/${p.id}`).set(owner.auth).send({ ...body, purposeCode: 'S0102' }).expect(200)).body.form15).toMatchObject({ part: 'NONE', needs15cb: false });
    p = (await ctx.http().put(`${IP()}/${p.id}`).set(owner.auth).send({ ...body, items: bills.map((b) => ({ documentId: b.id })), charges: 'SHA', form15caAck: '271234567890123', form15cbNumber: 'CB-2026-778' }).expect(200)).body;
    expect(p).toMatchObject({ charges: 'SHA', form15: { part: 'C', ack: '271234567890123', cb: 'CB-2026-778' } });
    (globalThis as { pid?: string }).pid = p.id;
  });

  it('is approved by someone other than the preparer once the bank details are verified', async () => {
    const pid = (globalThis as { pid?: string }).pid!;
    expect((await ctx.http().post(`${IP()}/${pid}/approve`).set(approver.auth).expect(409)).body.message).toBe("The vendor's international bank details are not verified yet");
    await ctx.http().post(`${org.base}/contacts/${vendor.id}/bank-details/verify`).set(approver.auth).send({ note: 'Called Acme finance on the number in the contract' }).expect(200);
    expect((await ctx.http().post(`${IP()}/${pid}/approve`).set(owner.auth).expect(409)).body.error).toBe('SAME_PERSON');
    const p = (await ctx.http().post(`${IP()}/${pid}/approve`).set(approver.auth).expect(200)).body;
    expect(p).toMatchObject({ status: 'APPROVED', approvedBy: 'Remit Approver', selfApproved: false, issues: [] });
    await ctx.http().put(`${IP()}/${pid}`).set(owner.auth).send({ contactId: vendor.id, bankAccountId: org.acc['1120'], paymentDate: T, currency: 'USD', items: [{ documentId: bills[0]!.id }] }).expect(409);
    await expect(raw(`UPDATE international_payments SET amount = 1 WHERE id = '${pid}'`)).rejects.toThrow(/cannot be changed/);
    await expect(raw(`DELETE FROM international_payment_items WHERE remittance_id = '${pid}'`)).rejects.toThrow(/cannot change/);
  });

  it('gives the bank the remittance instruction, then records the payment at the bank rate', async () => {
    const pid = (globalThis as { pid?: string }).pid!;
    await ctx.http().post(`${IP()}/${pid}/paid`).set(owner.auth).send({ rate: '84' }).expect(409);
    const file = await ctx.http().post(`${IP()}/${pid}/instruction`).set(owner.auth).expect(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.text).toContain('Amount,7000.00');
    expect(file.text).toContain('Beneficiary bank SWIFT/BIC,CHASUS33');
    expect(file.text).toContain('Routing code,021000021');
    expect(file.text).toContain('Purpose code,S0802');
    expect(file.text).toContain('Charges,SHA');
    expect(file.text).toContain('Form 15CB,CB-2026-778');
    expect(file.text).toMatch(/Invoices paid,.*AC-1001/);
    let p = (await ctx.http().get(`${IP()}/${pid}`).set(clerk.auth).expect(200)).body;
    expect(p).toMatchObject({ status: 'SENT', sentBy: 'Remit Owner' });
    p = (await ctx.http().post(`${IP()}/${pid}/paid`).set(owner.auth).send({ rate: '84', bankReference: 'OWR/26/55120' }).expect(200)).body;
    expect(p).toMatchObject({ status: 'PAID', paidRate: '84', paidInr: '588000.00', bankReference: 'OWR/26/55120', payment: { number: expect.any(String) } });
    for (const b of bills) {
      const d = (await ctx.http().get(`${org.base}/purchases/documents/${b.id}`).set(owner.auth).expect(200)).body;
      expect(d.amountDue ?? d.outstanding ?? d.due).toMatch(/^0(\.0+)?$/);
    }
    await ctx.http().post(`${IP()}/${pid}/cancel`).set(owner.auth).send({ reason: 'late' }).expect(409);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'international_payment', entityId: pid }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['international_payment.prepared', 'international_payment.approved', 'international_payment.instruction_downloaded', 'international_payment.paid']));
  });

  it('counts payments already sent this financial year towards ₹5 lakh, and cancels drafts', async () => {
    const small = await postBill('100', 'AC-1003');
    const p = (await ctx.http().post(IP()).set(owner.auth).send({ contactId: vendor.id, bankAccountId: org.acc['1120'], paymentDate: T, currency: 'USD', items: [{ documentId: small.id }], purposeCode: 'S0802' }).expect(201)).body;
    // Only USD 100 now, but USD 7,000 already went this year.
    expect(p.form15).toMatchObject({ part: 'C', needs15cb: true, inrBefore: '588000.00' });
    const c = (await ctx.http().post(`${IP()}/${p.id}/cancel`).set(owner.auth).send({ reason: 'Paying with next month’s run' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'CANCELLED', cancelledBy: 'Remit Owner' });
    const list = (await ctx.http().get(IP()).set(clerk.auth).expect(200)).body;
    expect(list.counts).toMatchObject({ PAID: 1, CANCELLED: 1 });
    expect(list.can.manage).toBe(false);
    const stranger = await registerUser(ctx, 'Remit Stranger');
    await ctx.http().get(IP()).set(stranger.auth).expect(404);
  });
});
