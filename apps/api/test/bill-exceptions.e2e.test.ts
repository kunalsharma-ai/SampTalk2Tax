import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Automated exception investigation (AP-035) against the real API and database: an order for
 * cartons and film, part received and billed; a draft bill for cartons not yet received at a price
 * the vendor has charged before, plus freight; and a draft bill that repeats the film already
 * billed. Each difference gets its likely cause, next step and amount at stake; accepting a
 * bill's differences takes it off the list; permissions and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let vendor: string;
let po: any;
let posted: any;
let priceBill: any;
let cartons: any;
let film: any;

const list = (user = owner, o = org) => ctx.http().get(`${o.base}/purchases/bill-exceptions`).set(user.auth);
const doc = (body: Record<string, unknown>) => ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, ...body }).expect(201).then((r) => r.body);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Exceptions Owner');
  approver = await registerUser(ctx, 'Exceptions Approver');
  viewer = await registerUser(ctx, 'Exceptions Viewer');
  outsider = await registerUser(ctx, 'Exceptions Outsider');
  org = await createOrg(ctx, owner, { name: 'Exception Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Exception Co' });
  for (const [u, role] of [[approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Kestrel Packaging', isVendor: true }).expect(201)).body.id;
  const P = `${org.base}/purchases/orders`;
  po = (
    await ctx.http().post(P).set(owner.auth).send({
      contactId: vendor, orderDate: addDays(T, -10),
      lines: [
        { accountId: org.acc['6600'], description: 'Packing cartons', quantity: '100', unitPrice: '40' },
        { accountId: org.acc['6600'], description: 'Stretch film rolls', quantity: '10', unitPrice: '250' },
      ],
    }).expect(201)
  ).body;
  po = (await ctx.http().post(`${P}/${po.id}/issue`).set(owner.auth).expect(200)).body;
  po = (await ctx.http().post(`${P}/${po.id}/receipts`).set(owner.auth).send({ receiptDate: addDays(T, -6), lines: [{ orderLineId: po.lines[0].id, quantity: '60' }, { orderLineId: po.lines[1].id, quantity: '10' }] }).expect(201)).body.order;
  // What was received is billed and posted: 60 cartons and 10 rolls of film.
  posted = (await ctx.http().post(`${P}/${po.id}/bill`).set(owner.auth).send({ issueDate: addDays(T, -5), reference: 'KP/INV/881' }).expect(201)).body;
  await ctx.http().post(`${org.base}/purchases/documents/${posted.documentId}/post`).set(owner.auth).send({}).expect(200);
  // A posted bill without an order since then charged 44 a carton.
  priceBill = await doc({ issueDate: addDays(T, -3), reference: 'KP/INV/890', post: true, lines: [{ accountId: org.acc['6600'], description: 'Packing cartons', quantity: '20', unitPrice: '44' }] });
  // 30 more cartons at 44 with freight (40 are still due on the order), and the film again.
  cartons = await doc({
    issueDate: addDays(T, -2), reference: 'KP/INV/902', purchaseOrderId: po.id,
    lines: [
      { accountId: org.acc['6600'], description: 'Packing cartons', quantity: '30', unitPrice: '44', purchaseOrderLineId: po.lines[0].id },
      { accountId: org.acc['6600'], description: 'Freight', quantity: '1', unitPrice: '500' },
    ],
  });
  film = await doc({ issueDate: addDays(T, -1), reference: 'KP/INV/905', purchaseOrderId: po.id, lines: [{ accountId: org.acc['6600'], description: 'Stretch film rolls', quantity: '10', unitPrice: '250', purchaseOrderLineId: po.lines[1].id }] });
});
afterAll(async () => {
  await ctx.app.close();
});

describe('bill exception investigation', () => {
  it('works out the likely cause, next step and amount at stake of each difference', async () => {
    const r = (await list().expect(200)).body;
    expect(r.summary).toMatchObject({ bills: 2, atStake: '4320.00', acceptable: 0, withVendor: 1, awaitingGoods: 1, byAction: expect.objectContaining({ VOID_DUPLICATE: 1, RECORD_RECEIPT: 1 }) });
    expect(r.items.map((i: any) => i.id)).toEqual([film.id, cartons.id]);
    const [f, c] = r.items;
    expect(f).toMatchObject({ number: null, reference: 'KP/INV/905', vendor: { id: vendor, name: 'Kestrel Packaging' }, order: { reference: po.reference }, nextAction: 'VOID_DUPLICATE', atStake: '2500.00', daysHeld: 1 });
    expect(f.findings).toHaveLength(1);
    expect(f.findings[0]).toMatchObject({ lineNo: 1, code: 'MORE_THAN_ORDERED', cause: 'POSSIBLE_DUPLICATE', amount: '2500.00', evidence: [{ id: posted.documentId }] });
    expect(f.findings[0].explanation).toMatch(/bills the same 10 at ₹250\.00 on order line 2; with this bill 20 would be billed against 10 ordered\.$/);
    expect(f.differences).toEqual(['Line 1: billing 20 in all against 10 ordered', 'Line 1: billing 20 in all against 10 received']);

    expect(c).toMatchObject({ nextAction: 'RECORD_RECEIPT', nextActionLabel: 'Record the goods received, then post', atStake: '1820.00', atStakeBase: '1820.00', acceptable: false });
    expect(c.findings.map((x: any) => [x.lineNo, x.cause, x.amount])).toEqual([
      [1, 'AWAITING_DELIVERY', '1320.00'],
      [1, 'VENDOR_PRICE_RISE', '120.00'],
      [2, 'EXTRA_CHARGE', '500.00'],
    ]);
    expect(c.findings[0].explanation).toContain(`30 of what is billed is not received yet, and 40 more are still due on ${po.reference} (ordered 100, received 60)`);
    expect(c.findings[1].explanation).toContain(`(10% more). ${priceBill.number}`);
    expect(c.findings[1].evidence).toEqual([{ id: priceBill.id, number: priceBill.number }]);
    expect(r.can).toEqual({ acceptDifferences: true, manage: true });
  });

  it('follows the bill: receiving the cartons leaves the price and freight to accept', async () => {
    await ctx.http().post(`${org.base}/purchases/orders/${po.id}/receipts`).set(owner.auth).send({ receiptDate: T, lines: [{ orderLineId: po.lines[0].id, quantity: '30' }] }).expect(201);
    const c = (await list().expect(200)).body.items.find((i: any) => i.id === cartons.id);
    expect(c.findings.map((x: any) => x.cause)).toEqual(['VENDOR_PRICE_RISE', 'EXTRA_CHARGE']);
    expect(c).toMatchObject({ nextAction: 'CONFIRM_PRICE', acceptable: true, atStake: '620.00' });
    // Once an approver accepts the differences the bill is no longer held.
    await ctx.http().post(`${org.base}/purchases/bills/${cartons.id}/match/accept`).set(approver.auth).send({ reason: 'New carton price agreed; freight per quote' }).expect(200);
    const r = (await list(approver).expect(200)).body;
    expect(r.items.map((i: any) => i.id)).toEqual([film.id]);
    expect(r.summary).toMatchObject({ bills: 1, atStake: '2500.00' });
  });

  it('is read by viewers, and kept to the organisation', async () => {
    const r = (await list(viewer).expect(200)).body;
    expect(r.items).toHaveLength(1);
    expect(r.can).toEqual({ acceptDifferences: false, manage: false });
    await list(outsider).expect(404);
    expect((await list(outsider, other).expect(200)).body).toMatchObject({ summary: { bills: 0, atStake: '0.00' }, items: [] });
  });
});
