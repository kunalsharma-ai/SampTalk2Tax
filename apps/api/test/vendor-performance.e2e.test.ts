import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AP-021 vendor performance against the real API and database: on-time delivery from goods
 * receipts, rejected goods by value, a bill above the order price whose differences were accepted,
 * vendor credits, and the team's reviews (append-only, withdrawn only by their author), combined
 * into a score and grade per vendor.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let buyer: TestUser;
let approver: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let good: string;
let slow: string;

const P = () => `${org.base}/purchases`;
const raw = (sql: string) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql);
  });

/** An issued order of 100 cartons at 40 and 10 rolls at 250, expected `expectIn` days after `orderDaysAgo` days ago. */
async function order(contactId: string, orderDaysAgo: number, expectIn: number) {
  const po = (
    await ctx.http().post(`${P()}/orders`).set(owner.auth).send({
      contactId,
      orderDate: addDays(T, -orderDaysAgo),
      expectedDate: addDays(T, -orderDaysAgo + expectIn),
      lines: [
        { accountId: org.acc['6600'], description: 'Packing cartons', quantity: '100', unitPrice: '40' },
        { accountId: org.acc['6600'], description: 'Stretch film rolls', quantity: '10', unitPrice: '250' },
      ],
    }).expect(201)
  ).body;
  return (await ctx.http().post(`${P()}/orders/${po.id}/issue`).set(owner.auth).expect(200)).body;
}
const receive = async (po: { id: string; lines: { id: string }[] }, daysAgo: number, lines: [string, string, string?][]) =>
  (await ctx.http().post(`${P()}/orders/${po.id}/receipts`).set(owner.auth).send({ receiptDate: addDays(T, -daysAgo), lines: lines.map(([i, q, r]) => ({ orderLineId: po.lines[Number(i)]!.id, quantity: q, ...(r ? { rejected: r } : {}) })) }).expect(201)).body.order;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Perf Owner');
  buyer = await registerUser(ctx, 'Perf Buyer');
  approver = await registerUser(ctx, 'Perf Approver');
  viewer = await registerUser(ctx, 'Perf Viewer');
  org = await createOrg(ctx, owner, { name: 'Vendor Performance Works' });
  for (const [u, role] of [[buyer, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  good = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Reliable Cartons', isVendor: true }).expect(201)).body.id;
  slow = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Slow Polymers', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('vendor performance', () => {
  it('scores a vendor that delivers on time with nothing rejected and bills at the order price', async () => {
    const po = await order(good, 30, 10);
    const done = await receive(po, 22, [['0', '100'], ['1', '10']]);
    expect(done.state).toBe('RECEIVED');
    const b = (await ctx.http().post(`${P()}/orders/${po.id}/bill`).set(owner.auth).send({ issueDate: addDays(T, -21), reference: 'RC/1' }).expect(201)).body;
    await ctx.http().post(`${P()}/documents/${b.documentId}/post`).set(owner.auth).send({}).expect(200);
    const d = (await ctx.http().get(`${P()}/vendors/${good}/performance`).set(viewer.auth).expect(200)).body;
    expect(d.scorecard).toMatchObject({
      orders: 1,
      delivery: { measured: 1, onTime: 1, onTimePercent: '100.0' },
      quality: { rejectedPercent: '0.00', receivedValue: '6500.00' },
      price: { linesAbovePrice: 0, overcharge: '0.00' },
      billing: { bills: 1, linkedBills: 1, accuracyPercent: '100.0', spend: '6500.00' },
      score: '100.0',
      grade: 'A',
    });
    expect(d.can.review).toBe(false);
  });

  it('marks a late, short and overcharging vendor down', async () => {
    // Late: expected 20 days ago, last delivery 15 days ago, with 10 cartons rejected.
    const late = await order(slow, 40, 20);
    await receive(late, 25, [['0', '60', '10']]);
    await receive(late, 15, [['0', '40'], ['1', '10']]);
    // Overdue: expected 5 days ago, nothing arrived.
    await order(slow, 15, 10);
    // A bill above the order price that an approver let through.
    const draft = (
      await ctx.http().post(`${P()}/documents`).set(buyer.auth).send({
        kind: 'BILL', contactId: slow, issueDate: addDays(T, -14), reference: 'SP/77', purchaseOrderId: late.id,
        lines: [{ accountId: org.acc['6600'], description: 'Packing cartons', quantity: '100', unitPrice: '42', purchaseOrderLineId: late.lines[0].id }],
      }).expect(201)
    ).body;
    await ctx.http().post(`${P()}/bills/${draft.id}/match/accept`).set(approver.auth).send({ reason: 'Price rise agreed by phone' }).expect(200);
    await ctx.http().post(`${P()}/documents/${draft.id}/post`).set(owner.auth).send({}).expect(200);
    const credit = (await ctx.http().post(`${P()}/documents`).set(owner.auth).send({ kind: 'VENDOR_CREDIT', contactId: slow, issueDate: addDays(T, -10), lines: [{ accountId: org.acc['6600'], description: 'Rejected cartons', quantity: '10', unitPrice: '40' }] }).expect(201)).body;
    await ctx.http().post(`${P()}/documents/${credit.id}/post`).set(owner.auth).send({}).expect(200);

    const s = (await ctx.http().get(`${P()}/vendors/${slow}/performance`).set(owner.auth).expect(200)).body.scorecard;
    expect(s.delivery).toMatchObject({ measured: 2, onTime: 0, late: 1, overdue: 1, onTimePercent: '0.0', averageDaysLate: '5.0' });
    expect(s.delivery.detail.map((x: { outcome: string; daysLate: number }) => [x.outcome, x.daysLate]).sort()).toEqual([['LATE', 5], ['OVERDUE', 5]]);
    // 10 rejected cartons at 40 against 110 cartons and 10 rolls received.
    expect(s.quality).toMatchObject({ receivedValue: '6900.00', rejectedValue: '400.00', rejectedPercent: '5.80' });
    expect(s.price).toMatchObject({ billedLines: 1, linesAbovePrice: 1, overcharge: '200.00', variancePercent: '5.00' });
    expect(s.billing).toMatchObject({ bills: 1, linkedBills: 1, withAcceptedDifferences: 1, accuracyPercent: '0.0', vendorCredits: 1, vendorCreditValue: '400.00' });
    expect(s.parts.map((p: { key: string }) => p.key)).toEqual(['DELIVERY', 'QUALITY', 'BILLING']);
    expect(s.grade).toBe('D');
  });

  it('takes the team’s reviews, which are never edited and only withdrawn by their author', async () => {
    const d = (await ctx.http().get(`${P()}/vendors/${slow}/performance`).set(buyer.auth).expect(200)).body;
    expect(d.can.review).toBe(true);
    await ctx.http().post(`${P()}/vendors/${slow}/reviews`).set(viewer.auth).send({ aspect: 'Delivery', rating: 3 }).expect(403);
    expect((await ctx.http().post(`${P()}/vendors/${slow}/reviews`).set(buyer.auth).send({ aspect: 'Delivery', rating: 1 }).expect(422)).body.message).toBe('Say what went wrong when rating 1 or 2');
    expect((await ctx.http().post(`${P()}/vendors/${slow}/reviews`).set(buyer.auth).send({ aspect: 'Delivery', rating: 7 }).expect(422)).body.message).toBe('A rating is a whole number from 1 to 5');
    expect((await ctx.http().post(`${P()}/vendors/${slow}/reviews`).set(buyer.auth).send({ aspect: 'Delivery', rating: 3, reviewDate: addDays(T, 1) }).expect(422)).body.message).toMatch(/future/);
    const goodOrder = (await ctx.http().get(`${P()}/vendors/${good}/performance`).set(owner.auth).expect(200)).body.orders[0];
    expect((await ctx.http().post(`${P()}/vendors/${slow}/reviews`).set(buyer.auth).send({ aspect: 'Delivery', rating: 3, orderId: goodOrder.id }).expect(422)).body.message).toBe('That purchase order is not from this vendor');

    const r1 = (await ctx.http().post(`${P()}/vendors/${slow}/reviews`).set(buyer.auth).send({ aspect: 'Delivery', rating: 2, note: 'Second late delivery this quarter', orderId: d.orders[0].id }).expect(201)).body;
    await ctx.http().post(`${P()}/vendors/${slow}/reviews`).set(owner.auth).send({ aspect: 'Communication', rating: 4, note: 'Always answers the phone' }).expect(201);
    let s = (await ctx.http().get(`${P()}/vendors/${slow}/performance`).set(owner.auth).expect(200)).body;
    expect(s.scorecard.reviews).toEqual({ count: 2, average: '3.0' });
    expect(s.scorecard.parts.find((p: { key: string }) => p.key === 'REVIEWS').score).toBe('50.0');
    expect(s.reviews.find((r: { id: string }) => r.id === r1.id)).toMatchObject({ order: { ref: expect.stringMatching(/^PO-/) } });

    await expect(raw(`UPDATE vendor_reviews SET rating = 5 WHERE id = '${r1.id}'`)).rejects.toThrow(/never edited/);
    await expect(raw(`DELETE FROM vendor_reviews WHERE id = '${r1.id}'`)).rejects.toThrow(/cannot be deleted/);
    expect((await ctx.http().post(`${P()}/vendors/${slow}/reviews/${r1.id}/withdraw`).set(owner.auth).send({ reason: 'Not mine' }).expect(403)).body.error).toBe('NOT_AUTHOR');
    await ctx.http().post(`${P()}/vendors/${slow}/reviews/${r1.id}/withdraw`).set(buyer.auth).send({ reason: 'The delay was our warehouse, not theirs' }).expect(200);
    await ctx.http().post(`${P()}/vendors/${slow}/reviews/${r1.id}/withdraw`).set(buyer.auth).send({ reason: 'again' }).expect(409);
    s = (await ctx.http().get(`${P()}/vendors/${slow}/performance`).set(buyer.auth).expect(200)).body;
    expect(s.scorecard.reviews).toEqual({ count: 1, average: '4.0' });
    expect(s.reviews.find((r: { id: string }) => r.id === r1.id)).toMatchObject({ mine: true, withdrawn: { by: 'Perf Buyer', reason: 'The delay was our warehouse, not theirs' } });
    // A customer cannot be reviewed as a vendor.
    const cust = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Just A Customer', isCustomer: true }).expect(201)).body.id;
    await ctx.http().post(`${P()}/vendors/${cust}/reviews`).set(owner.auth).send({ aspect: 'Overall', rating: 4 }).expect(404);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'vendor_review' }, select: { action: true } });
    expect(audit.map((a) => a.action).sort()).toEqual(['vendor_review.created', 'vendor_review.created', 'vendor_review.withdrawn']);
  });

  it('lists every vendor best first for a period, and keeps other organisations out', async () => {
    const l = (await ctx.http().get(`${P()}/vendor-performance`).set(viewer.auth).expect(200)).body;
    expect(l.vendors.map((v: { contact: { name: string }; grade: string }) => [v.contact.name, v.grade])).toEqual([['Reliable Cartons', 'A'], ['Slow Polymers', 'D']]);
    expect(l.counts).toMatchObject({ A: 1, D: 1, ungraded: 0 });
    expect(l.vendors[1]).toMatchObject({ late: 2, overcharge: '200.00', spend: '4200.00', reviews: { count: 1 } });
    // A period before any of it: nothing to show.
    const old = (await ctx.http().get(`${P()}/vendor-performance?from=${addDays(T, -400)}&to=${addDays(T, -100)}`).set(viewer.auth).expect(200)).body;
    expect(old.vendors).toEqual([]);
    await ctx.http().get(`${P()}/vendor-performance?from=${T}&to=${addDays(T, -1)}`).set(viewer.auth).expect(422);
    const stranger = await registerUser(ctx, 'Perf Stranger');
    await ctx.http().get(`${P()}/vendor-performance`).set(stranger.auth).expect(404);
  });
});
