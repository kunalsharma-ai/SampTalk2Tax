import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Payment fraud indicators (AP-028) against the real API and database: a vendor paid into an
 * employee's salary account, bank details changed and unverified before a batch made by the same
 * person, two payments of the same amount within a week, a payment to a brand-new vendor set
 * against no bill, two vendors with almost the same name; an ordinary payment raises nothing; no
 * account number is ever shown; permissions and tenant isolation.
 */
const T = today();
const APR = `${Number(T.slice(0, 4)) - (T.slice(5, 7) < '04' ? 1 : 0)}-04`;
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const v: Record<string, string> = {};

type Row = { key: string; source: string; ref: { label: string; status?: string }; vendor: string; date: string; amount: string; currency: string; level: string; indicators: { code: string; level: string; detail: string }[] };
type Res = { asOf: string; windowDays: number; summary: { checked: number; flagged: number; high: number; medium: number; low: number; inBatches: number }; payments: Row[] };
const bill = async (vendor: string, amount: string) =>
  (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: v[vendor], issueDate: addDays(T, -10), post: true, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: amount }] }).expect(201)).body as { id: string };
const pay = async (vendor: string, date: string, amount: string, billId?: string) =>
  (await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: v[vendor], date, bankAccountId: org.acc['1120'], amount, allocations: billId ? [{ documentId: billId, amount }] : [] }).expect(201)).body;
const bank = (vendor: string, accountNumber: string) => ctx.http().put(`/v1/orgs/${org.orgId}/contacts/${v[vendor]}/bank-details`).set(owner.auth).send({ accountName: vendor, accountNumber, ifsc: 'HDFC0001234' }).expect(200);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Fraud Owner');
  viewer = await registerUser(ctx, 'Fraud Viewer');
  outsider = await registerUser(ctx, 'Fraud Outsider');
  org = await createOrg(ctx, owner, { name: 'Fraud Watch Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Fraud Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const name of ['Clean Co', 'Ravi Services', 'Swift Logistics', 'Maple Paper', 'Teak Supplies Pvt Ltd', 'Teak Supplies Limited']) v[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isVendor: true }).expect(201)).body.id;
  // Every vendor so far has been with us for two years.
  await ctx.db.collection('contacts').updateMany({ _id: { $in: Object.values(v) } } as never, { $set: { createdAt: new Date(Date.now() - 730 * 86_400_000) } });
  v['Fresh Vendor'] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Fresh Vendor', isVendor: true }).expect(201)).body.id;

  // Ravi Services is paid into Ravi's own salary account.
  await ctx.http().put(`${org.base}/payroll/settings`).set(owner.auth).send({}).expect(200);
  const structure = { effectiveFrom: `${APR}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '30000' }] };
  await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'E001', name: 'Ravi Kumar', dateOfJoining: `${APR}-01`, structure, bankAccountName: 'Ravi Kumar', bankAccountNumber: '5010 0012 3456 78', bankIfsc: 'HDFC0001234' }).expect(201);
  await bank('Ravi Services', '50100012345678');
  await pay('Ravi Services', addDays(T, -5), '18000.00', (await bill('Ravi Services', '18000')).id);

  // Clean Co: an ordinary payment of a bill.
  await pay('Clean Co', addDays(T, -3), '7300.50', (await bill('Clean Co', '7300.50')).id);
  // Maple Paper: the same amount twice in three days.
  await pay('Maple Paper', addDays(T, -6), '5000.00', (await bill('Maple Paper', '5000')).id);
  await pay('Maple Paper', addDays(T, -3), '5000.00', (await bill('Maple Paper', '5000')).id);
  // Fresh Vendor: an advance against no bill. Teak Supplies Pvt Ltd: an ordinary payment, but a near-namesake.
  await pay('Fresh Vendor', T, '25000.00');
  await pay('Teak Supplies Pvt Ltd', addDays(T, -2), '3200.00', (await bill('Teak Supplies Pvt Ltd', '3200')).id);
  // Swift Logistics: bank details just changed, unverified, and the same person prepares the batch.
  await bank('Swift Logistics', '9988776655');
  const sb = await bill('Swift Logistics', '42000');
  await ctx.http().post(`${org.base}/purchases/payment-batches`).set(owner.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, items: [{ documentId: sb.id }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('payment fraud indicators', () => {
  it('flags the warning signs on batch items and recorded payments, most serious first', async () => {
    const r = (await ctx.http().get(`${org.base}/payment-fraud`).set(viewer.auth).expect(200)).body as Res;
    expect(r).toMatchObject({ asOf: T, windowDays: 90 });
    const by = (vendor: string) => r.payments.filter((p) => p.vendor === vendor);
    const codes = (vendor: string) => by(vendor).map((p) => p.indicators.map((i) => i.code));

    expect(by('Clean Co')).toEqual([]);
    // The bank details were entered after this payment, so only the shared account counts.
    expect(codes('Ravi Services')).toEqual([['EMPLOYEE_ACCOUNT']]);
    expect(by('Ravi Services')[0]!.indicators[0]!.detail).toBe('The bank account is also the salary account of Ravi Kumar');

    const swift = by('Swift Logistics');
    expect(swift).toHaveLength(1);
    expect(swift[0]).toMatchObject({ source: 'BATCH', ref: { label: 'Batch 1', status: 'DRAFT' }, amount: '42000.00', currency: 'INR', level: 'HIGH' });
    expect(swift[0]!.indicators.map((i) => i.code)).toEqual(['BANK_CHANGED_UNVERIFIED', 'SAME_PERSON']);

    expect(codes('Maple Paper')).toEqual([['DUPLICATE_PAYMENT'], ['DUPLICATE_PAYMENT']]);
    expect(by('Maple Paper')[0]!.indicators[0]!.detail).toMatch(/^Another payment of ₹5,000\.00 to this vendor within 7 days \(\d{4}-\d{2}-\d{2}\)$/);

    expect(by('Fresh Vendor')[0]).toMatchObject({ level: 'MEDIUM', source: 'PAYMENT' });
    expect(codes('Fresh Vendor')).toEqual([['NEW_VENDOR', 'NO_BILL']]);
    expect(codes('Teak Supplies Pvt Ltd')).toEqual([['SIMILAR_NAME']]);
    expect(by('Teak Supplies Pvt Ltd')[0]!.indicators[0]!.detail).toBe('Another vendor has almost the same name: Teak Supplies Limited');

    // Most serious first, batches before recorded payments at the same level.
    expect(r.payments[0]!.source).toBe('BATCH');
    expect(r.payments.map((p) => p.level)).toEqual([...r.payments.map((p) => p.level)].sort((a, b) => ['HIGH', 'MEDIUM', 'LOW'].indexOf(a) - ['HIGH', 'MEDIUM', 'LOW'].indexOf(b)));
    expect(r.summary).toEqual({ checked: 7, flagged: 6, high: 4, medium: 1, low: 1, inBatches: 1 });
    expect(JSON.stringify(r)).not.toMatch(/50100012345678|9988776655/);
  });

  it('keeps to the organisation', async () => {
    await ctx.http().get(`${org.base}/payment-fraud`).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/payment-fraud`).set(outsider.auth).expect(200)).body as Res;
    expect(theirs).toMatchObject({ payments: [], summary: { checked: 0, flagged: 0 } });
  });
});
