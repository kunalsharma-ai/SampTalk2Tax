import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * AR-015 retainers against the real API and database: terms, receipts recorded into a retainer
 * (or an existing unapplied receipt added), the held balance and top-up due, drawdowns onto chosen
 * invoices or oldest due first (ordinary allocations, oldest receipt first), a void receipt leaving
 * the balance, closing only when empty, permissions, tenant isolation and the database guards.
 */
const T = today();

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let otherCustomer: { id: string };

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const invoice = async (amount: string, dueDate: string, contactId = customer.id) => {
  const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId, issueDate: T, dueDate, lines: [{ accountId: org.acc['4100'], description: 'Advisory', quantity: '1', unitPrice: amount }] }).expect(201)).body;
  return (await ctx.http().post(`${org.base}/sales/documents/${d.id}/post`).set(owner.auth).send({}).expect(200)).body;
};
const R = () => `${org.base}/sales/retainers`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Retainer Owner');
  viewer = await registerUser(ctx, 'Retainer Viewer');
  outsider = await registerUser(ctx, 'Retainer Outsider');
  org = await createOrg(ctx, owner, { name: 'Retainer Advisors LLP' });
  other = await createOrg(ctx, outsider, { name: 'Other Retainers Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Mehta Exports', isCustomer: true }).expect(201)).body;
  otherCustomer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Someone Else', isCustomer: true }).expect(201)).body;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('retainers', () => {
  let rid: string;
  it('are agreed per customer with a level and a minimum', async () => {
    const bad = await ctx.http().post(R()).set(owner.auth).send({ contactId: customer.id, name: 'Monthly advisory', amount: '50000', minimumBalance: '60000', startDate: T }).expect(422);
    expect(bad.body.message).toBe('The minimum balance cannot be more than the agreed amount');
    await ctx.http().post(R()).set(viewer.auth).send({ contactId: customer.id, name: 'Monthly advisory', amount: '100000', minimumBalance: '25000', startDate: T }).expect(403);
    const r = await ctx.http().post(R()).set(owner.auth).send({ contactId: customer.id, name: 'Monthly advisory', amount: '100000', minimumBalance: '25000', startDate: T, terms: 'Kept at ₹1,00,000; topped up within 7 days.' }).expect(201);
    rid = r.body.id;
    expect(r.body).toMatchObject({ reference: 'RT-0001', state: 'EMPTY', held: '0.00', topUpDue: '100000.00', contact: { name: 'Mehta Exports' } });
  });

  it('hold receipts recorded into them, and unapplied receipts added to them', async () => {
    const a = await ctx.http().post(`${R()}/${rid}/receipts`).set(owner.auth).send({ date: T, bankAccountId: org.acc['1120'], amount: '60000' }).expect(201);
    expect(a.body).toMatchObject({ state: 'HEALTHY', held: '60000.00', topUpDue: '0.00' });
    expect(a.body.receipts[0]).toMatchObject({ amount: '60000.00', left: '60000.00', reference: 'RT-0001' });
    // An unapplied receipt recorded the ordinary way can be added; one from another customer cannot.
    const loose = (await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: customer.id, date: T, bankAccountId: org.acc['1120'], amount: '15000' }).expect(201)).body;
    const elsewhere = (await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: otherCustomer.id, date: T, bankAccountId: org.acc['1120'], amount: '5000' }).expect(201)).body;
    const before = (await ctx.http().get(`${R()}/${rid}`).set(owner.auth).expect(200)).body;
    expect(before.otherReceipts.map((x: { id: string }) => x.id)).toEqual([loose.id]);
    expect((await ctx.http().post(`${R()}/${rid}/receipts`).set(owner.auth).send({ paymentId: elsewhere.id }).expect(422)).body.message).toBe('This receipt is from another customer');
    const b = await ctx.http().post(`${R()}/${rid}/receipts`).set(owner.auth).send({ paymentId: loose.id }).expect(201);
    expect(b.body).toMatchObject({ held: '75000.00', otherReceipts: [] });
    expect((await ctx.http().post(`${R()}/${rid}/receipts`).set(owner.auth).send({ paymentId: loose.id }).expect(422)).body.message).toBe('This receipt is already part of a retainer');
    // The customer is in credit by what is held.
    const ageing = (await ctx.http().get(`${org.base}/sales/ageing`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(ageing)).toContain('Mehta Exports');
  });

  it('pay chosen invoices, oldest receipt first, with ordinary allocations', async () => {
    const i1 = await invoice('30000', T);
    const i2 = await invoice('40000', T);
    expect((await ctx.http().post(`${R()}/${rid}/drawdown`).set(owner.auth).send({ invoices: [{ documentId: i1.id, amount: '31000' }] }).expect(422)).body.message).toBe(`${i1.number}: only 30000 is still owed`);
    const d = await ctx.http().post(`${R()}/${rid}/drawdown`).set(owner.auth).send({ invoices: [{ documentId: i2.id, amount: '40000' }, { documentId: i1.id, amount: '20000' }] }).expect(200);
    expect(d.body).toMatchObject({ total: '60000.00', invoices: 2, retainer: { held: '15000.00', state: 'LOW', topUpDue: '85000.00' } });
    expect(d.body.retainer.drawdowns.map((x: { invoice: { number: string }; amount: string }) => `${x.invoice.number} ${x.amount}`).sort()).toEqual([`${i1.number} 20000.00`, `${i2.number} 40000.00`].sort());
    expect(d.body.retainer.receipts.map((x: { left: string }) => x.left)).toEqual(['0.00', '15000.00']);
    const inv1 = (await ctx.http().get(`${org.base}/sales/documents/${i1.id}`).set(owner.auth).expect(200)).body;
    expect(inv1.amountDue).toBe('10000.00');
    expect((await ctx.http().post(`${R()}/${rid}/drawdown`).set(owner.auth).send({ invoices: [{ documentId: i1.id, amount: '10000' }, { documentId: i1.id, amount: '1' }] }).expect(422)).body.error).toBe('RETAINER_DRAWDOWN_INVALID');
  });

  it('pay every open invoice oldest due first up to what is held', async () => {
    await invoice('50000', T);
    const d = await ctx.http().post(`${R()}/${rid}/drawdown`).set(owner.auth).send({ oldestFirst: true }).expect(200);
    expect(d.body).toMatchObject({ total: '15000.00', retainer: { held: '0.00', state: 'EMPTY' } });
    expect((await ctx.http().post(`${R()}/${rid}/drawdown`).set(owner.auth).send({ oldestFirst: true }).expect(422)).body.error).toBe('RETAINER_EMPTY');
  });

  it('lose a void receipt from the balance, and close only when empty', async () => {
    const t = await ctx.http().post(`${R()}/${rid}/receipts`).set(owner.auth).send({ date: T, bankAccountId: org.acc['1120'], amount: '5000' }).expect(201);
    expect(t.body.held).toBe('5000.00');
    expect((await ctx.http().post(`${R()}/${rid}/close`).set(owner.auth).send({ reason: 'Engagement ended' }).expect(422)).body.error).toBe('RETAINER_NOT_EMPTY');
    const last = t.body.receipts.at(-1);
    await ctx.http().post(`${org.base}/sales/payments/${last.id}/void`).set(owner.auth).send({ reason: 'Refunded by bank transfer' }).expect(200);
    expect((await ctx.http().get(`${R()}/${rid}`).set(owner.auth).expect(200)).body.held).toBe('0.00');
    const c = await ctx.http().post(`${R()}/${rid}/close`).set(owner.auth).send({ reason: 'Engagement ended' }).expect(200);
    expect(c.body).toMatchObject({ status: 'CLOSED', state: 'CLOSED', closeReason: 'Engagement ended', topUpDue: '0.00' });
    expect((await ctx.http().post(`${R()}/${rid}/receipts`).set(owner.auth).send({ date: T, bankAccountId: org.acc['1120'], amount: '1' }).expect(422)).body.error).toBe('RETAINER_CLOSED');
    const list = (await ctx.http().get(`${R()}?view=all`).set(viewer.auth).expect(200)).body;
    expect(list.retainers).toHaveLength(1);
    expect(list.can.manage).toBe(false);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=retainer`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(audit)).toContain('retainer.drawn_down');
  });
});

describe('isolation and guards', () => {
  it('keeps other organisations out', async () => {
    const r = (await ctx.http().post(R()).set(owner.auth).send({ contactId: customer.id, name: 'Second', amount: '1000', minimumBalance: '0', startDate: T }).expect(201)).body;
    await ctx.http().get(`${other.base}/sales/retainers/${r.id}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${org.base}/sales/retainers/${r.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().post(`${other.base}/sales/retainers`).set(outsider.auth).send({ contactId: customer.id, name: 'X', amount: '1', minimumBalance: '0', startDate: T }).expect(422)).body.error).toBe('RETAINER_CUSTOMER');
  });

  it('the database refuses deleting retainers, reopening closed ones and moving receipts', async () => {
    await expect(raw(`DELETE FROM retainers WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be deleted/);
    await expect(raw(`UPDATE retainers SET status = 'ACTIVE', closed_at = NULL WHERE org_id = '${org.orgId}' AND status = 'CLOSED'`)).rejects.toThrow(/retainer is closed/);
    await expect(raw(`DELETE FROM retainer_receipts WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be changed or removed/);
    await expect(raw(`UPDATE retainers SET contact_id = '${otherCustomer.id}' WHERE org_id = '${org.orgId}' AND status = 'ACTIVE'`)).rejects.toThrow(/keeps its customer/);
  });
});
