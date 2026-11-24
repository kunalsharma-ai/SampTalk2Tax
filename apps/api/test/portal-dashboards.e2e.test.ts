import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-060/061: the dashboards at the top of the vendor and customer portals, against the real
 * API and database. Each counterparty sees only their own open amounts by how late they are, what
 * falls due next and a year of invoices and payments; nothing of anyone else's.
 */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
let customerToken: string;
let vendorToken: string;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Portal Dashboard Owner');
  org = await createOrg(ctx, owner, { name: 'Portal Dashboard Traders' });
  const contact = async (name: string, kind: 'isCustomer' | 'isVendor') => (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id as string;
  const customer = await contact('Lotus Hotels', 'isCustomer');
  const otherCustomer = await contact('Lily Cafes', 'isCustomer');
  const vendor = await contact('Teak Furniture', 'isVendor');
  const invoice = async (contactId: string, amount: string, issueDate: string) => {
    const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId, issueDate, dueDate: addDays(issueDate, 15), lines: [{ accountId: org.acc['4100'], description: 'Rooms', quantity: '1', unitPrice: amount }] }).expect(201)).body;
    return (await ctx.http().post(`${org.base}/sales/documents/${d.id}/post`).set(owner.auth).send({}).expect(200)).body.id as string;
  };
  const bill = async (amount: string, issueDate: string, reference: string) =>
    (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate, dueDate: addDays(issueDate, 30), reference, post: true, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: amount }] }).expect(201)).body.id as string;
  const oldInvoice = await invoice(customer, '10000.00', addDays(T, -40));
  await invoice(customer, '6000.00', T);
  await invoice(otherCustomer, '3333.00', T);
  await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: customer, date: T, bankAccountId: org.acc['1120'], amount: '4000.00', reference: 'NEFT 1', allocations: [{ documentId: oldInvoice, amount: '4000.00' }] }).expect(201);
  const oldBill = await bill('20000.00', addDays(T, -45), 'TF/1');
  await bill('8000.00', addDays(T, -5), 'TF/2');
  await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: vendor, date: T, bankAccountId: org.acc['1120'], amount: '15000.00', reference: 'UTR 1', allocations: [{ documentId: oldBill, amount: '15000.00' }] }).expect(201);
  customerToken = (await ctx.http().post(`${org.base}/contacts/${customer}/portal-links`).set(owner.auth).send({ expiresInDays: 90 }).expect(201)).body.token;
  vendorToken = (await ctx.http().post(`${org.base}/contacts/${vendor}/vendor-portal-links`).set(owner.auth).send({ expiresInDays: 90 }).expect(201)).body.token;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('portal dashboards', () => {
  it('shows the customer what they owe by how late it is, what is due next and a year of invoices and payments', async () => {
    const d = (await ctx.http().get(`/v1/portal/${customerToken}`).expect(200)).body.dashboard;
    expect(d.currency).toBe('INR');
    expect(d.aging).toMatchObject({ total: '12000.00', overdue: '6000.00' });
    expect(d.aging.buckets.map((b: { bucket: string; amount: string }) => `${b.bucket} ${b.amount}`)).toEqual(['CURRENT 6000.00', 'DAYS_1_30 6000.00', 'DAYS_31_60 0.00', 'DAYS_61_90 0.00', 'OVER_90 0.00']);
    expect(d.nextDue).toEqual({ date: addDays(T, 15), amount: '6000.00', items: 1 });
    expect(d.dueIn30Days).toBe('6000.00');
    expect(d.months).toHaveLength(12);
    expect(d.months.at(-1).month).toBe(T.slice(0, 7));
    expect(d.months.at(-1).paid).toBe('4000.00');
    // Only this customer's invoices: the other customer's 3,333 is not counted.
    expect(d.lastTwelveMonths).toEqual({ invoiced: '16000.00', paid: '4000.00' });
  });

  it('shows the vendor what they are owed by how late it is, what is due next and a year of bills and payments', async () => {
    const d = (await ctx.http().get(`/v1/vendor-portal/${vendorToken}`).expect(200)).body.dashboard;
    expect(d.aging).toMatchObject({ total: '13000.00', overdue: '5000.00' });
    expect(d.aging.buckets.find((b: { bucket: string }) => b.bucket === 'DAYS_1_30').amount).toBe('5000.00');
    expect(d.nextDue).toEqual({ date: addDays(T, 25), amount: '8000.00', items: 1 });
    expect(d.lastTwelveMonths).toEqual({ invoiced: '28000.00', paid: '15000.00' });
  });

  it('refuses a made-up link', async () => {
    await ctx.http().get(`/v1/portal/t2tp_${'x'.repeat(40)}`).expect(404);
    await ctx.http().get(`/v1/vendor-portal/t2tv_${'x'.repeat(40)}`).expect(404);
  });
});
