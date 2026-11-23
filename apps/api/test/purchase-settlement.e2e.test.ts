import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Settling bills on the purchases side (AP-008 partial payments, AP-009 unapplied payments as a
 * vendor credit, AP-010 vendor credits) against the real API and database: a bill paid in two
 * parts, an overpayment kept as a credit with the vendor and applied to the next bill, a vendor
 * credit note applied to a bill, limits on what can be applied, removing an application, and the
 * payables control account, the ageing and the vendor statement agreeing throughout.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let vendor: string;
const ids: Record<string, string> = {};

const bill = async (key: string, amount: string, reference: string) =>
  (ids[key] = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, dueDate: T, reference, post: true, lines: [{ accountId: org.acc['6600'], description: 'Synthetic supplies', quantity: '1', unitPrice: amount }] }).expect(201)).body.id);
const pay = (amount: string, allocations: { documentId: string; amount: string }[] = [], reference = 'UTR') =>
  ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: vendor, date: T, bankAccountId: org.acc['1120'], amount, reference, allocations });
const doc = async (key: string) => (await ctx.http().get(`${org.base}/purchases/documents/${ids[key]}`).set(owner.auth).expect(200)).body as { amountDue: string; paymentStatus: string; allocations: { id: string; amount: string }[] };
const payment = async (key: string) => (await ctx.http().get(`${org.base}/purchases/payments/${ids[key]}`).set(owner.auth).expect(200)).body as { allocated: string; unallocated: string };
async function tb(code: string) {
  const t = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${T}`).set(owner.auth).expect(200)).body;
  return t.rows.find((r: { code: string }) => r.code === code)?.balance ?? '0.00';
}
async function books() {
  const a = (await ctx.http().get(`${org.base}/purchases/ageing?asOf=${T}`).set(owner.auth).expect(200)).body;
  const row = a.rows.find((r: { contactId: string }) => r.contactId === vendor);
  const s = (await ctx.http().get(`${org.base}/contacts/${vendor}/statement?ledger=PURCHASES&from=2000-01-01`).set(owner.auth).expect(200)).body;
  expect(a.reconciliation.difference).toBe('0.00');
  // balance is net: open bills less payments and credits not applied yet.
  return { control: await tb('2100'), net: row?.balance ?? '0.00', unapplied: row?.unapplied ?? '0.00', statement: s.closingBalance as string };
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Settlement Owner');
  viewer = await registerUser(ctx, 'Settlement Viewer');
  org = await createOrg(ctx, owner, { name: 'Settling Traders Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Paper Mills', isVendor: true }).expect(201)).body.id;
  await bill('B1', '10000.00', 'SPM/101');
  await bill('B2', '5000.00', 'SPM/102');
});
afterAll(async () => ctx?.app.close());

describe('settling bills', () => {
  it('pays a bill in two parts (AP-008)', async () => {
    expect(await books()).toEqual({ control: '15000.00', net: '15000.00', unapplied: '0.00', statement: '15000.00' });
    ids.P1 = (await pay('4000.00', [{ documentId: ids.B1!, amount: '4000.00' }], 'UTR-1').expect(201)).body.id;
    expect(await doc('B1')).toMatchObject({ amountDue: '6000.00', paymentStatus: 'PARTIAL' });
    expect(await books()).toEqual({ control: '11000.00', net: '11000.00', unapplied: '0.00', statement: '11000.00' });
  });

  it('keeps an overpayment as a credit with the vendor and applies it to the next bill (AP-009)', async () => {
    const p2 = (await pay('9000.00', [{ documentId: ids.B1!, amount: '6000.00' }], 'UTR-2').expect(201)).body;
    ids.P2 = p2.id;
    expect(p2).toMatchObject({ allocated: '6000.00', unallocated: '3000.00' });
    expect(await doc('B1')).toMatchObject({ amountDue: '0.00', paymentStatus: 'PAID' });
    // B2 is still owed; 3,000 sits with the vendor as an advance.
    expect(await books()).toEqual({ control: '2000.00', net: '2000.00', unapplied: '3000.00', statement: '2000.00' });
    await ctx.http().post(`${org.base}/purchases/payments/${ids.P2}/allocate`).set(viewer.auth).send({ allocations: [{ documentId: ids.B2!, amount: '3000.00' }] }).expect(403);
    await ctx.http().post(`${org.base}/purchases/payments/${ids.P2}/allocate`).set(owner.auth).send({ allocations: [{ documentId: ids.B2!, amount: '3000.01' }] }).expect(422);
    await ctx.http().post(`${org.base}/purchases/payments/${ids.P2}/allocate`).set(owner.auth).send({ allocations: [{ documentId: ids.B2!, amount: '3000.00' }] }).expect(200);
    expect(await payment('P2')).toMatchObject({ allocated: '9000.00', unallocated: '0.00' });
    expect(await doc('B2')).toMatchObject({ amountDue: '2000.00', paymentStatus: 'PARTIAL' });
    expect(await books()).toEqual({ control: '2000.00', net: '2000.00', unapplied: '0.00', statement: '2000.00' });
  });

  it('applies a vendor credit to a bill (AP-010)', async () => {
    const vc = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'VENDOR_CREDIT', contactId: vendor, issueDate: T, reference: 'SPM/CN/7', post: true, lines: [{ accountId: org.acc['6600'], description: 'Short supply', quantity: '1', unitPrice: '1500.00' }] }).expect(201)).body;
    ids.VC = vc.id;
    // Owed 2,000 on B2 less the 1,500 credit not applied yet.
    expect(await books()).toEqual({ control: '500.00', net: '500.00', unapplied: '1500.00', statement: '500.00' });
    const over = await ctx.http().post(`${org.base}/purchases/documents/${ids.B2}/apply-credit`).set(owner.auth).send({ creditDocumentId: vc.id, amount: '2000.01' }).expect(422);
    expect(over.body.message).toBeTruthy();
    await ctx.http().post(`${org.base}/purchases/documents/${ids.B2}/apply-credit`).set(owner.auth).send({ creditDocumentId: vc.id, amount: '1500.00' }).expect(200);
    expect(await doc('B2')).toMatchObject({ amountDue: '500.00', paymentStatus: 'PARTIAL' });
    expect((await doc('VC')).amountDue).toBe('0.00');
    expect(await books()).toEqual({ control: '500.00', net: '500.00', unapplied: '0.00', statement: '500.00' });
  });

  it('removes an application, reopening both sides', async () => {
    const b1 = await doc('B1');
    const second = b1.allocations.find((a) => a.amount === '6000.00')!;
    await ctx.http().post(`${org.base}/purchases/allocations/${second.id}/remove`).set(owner.auth).expect(200);
    expect(await doc('B1')).toMatchObject({ amountDue: '6000.00', paymentStatus: 'PARTIAL' });
    expect(await payment('P2')).toMatchObject({ unallocated: '6000.00' });
    // 6,500 open on the bills, 6,000 back with the vendor as an advance: still 500 net.
    expect(await books()).toEqual({ control: '500.00', net: '500.00', unapplied: '6000.00', statement: '500.00' });
  });
});
