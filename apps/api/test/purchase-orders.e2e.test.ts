/**
 * AP-015/016/017 purchase orders, goods receipts and bill matching against the real API and
 * database: a draft order worked out by the bill rules, issued (then fixed, also by the
 * database), goods received (over-receipt refused), a bill made from what was received, three-way
 * matching blocking a bill that bills more than received or above the order price until the
 * differences are accepted by an approver, two-way matching, cancelling receipts and orders,
 * closing, permissions and isolation.
 */
import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
let vendor: string;
let otherVendor: string;
let po: any;
const P = () => `${org.base}/purchases/orders`;
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const body = (extra: Record<string, unknown> = {}) => ({
  contactId: vendor,
  orderDate: addDays(T, -10),
  expectedDate: addDays(T, -2),
  reference: 'VQ-2211',
  terms: 'Delivery to the Pune warehouse',
  lines: [
    { accountId: org.acc['6600'], description: 'Packing cartons', quantity: '100', unitPrice: '40' },
    { accountId: org.acc['6600'], description: 'Stretch film rolls', quantity: '10', unitPrice: '250' },
  ],
  ...extra,
});
const bill = (id: string) => ctx.http().get(`${org.base}/purchases/documents/${id}`).set(owner.auth).expect(200).then((r) => r.body);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'PO Owner');
  accountant = await registerUser(ctx, 'PO Accountant');
  approver = await registerUser(ctx, 'PO Approver');
  viewer = await registerUser(ctx, 'PO Viewer');
  outsider = await registerUser(ctx, 'PO Outsider');
  org = await createOrg(ctx, owner, { name: 'Purchase Order Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other PO Org' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) {
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Kestrel Packaging', isVendor: true }).expect(201)).body.id;
  otherVendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Heron Plastics', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('purchase orders', () => {
  it('drafts, edits and issues an order; issued orders are fixed', async () => {
    await ctx.http().post(P()).set(viewer.auth).send(body()).expect(403);
    expect((await ctx.http().post(P()).set(owner.auth).send(body({ priceTolerancePercent: '120' })).expect(422)).body.message).toMatch(/between 0 and 100/);
    expect((await ctx.http().post(P()).set(owner.auth).send(body({ expectedDate: addDays(T, -20) })).expect(422)).body.message).toMatch(/expected delivery date/);
    po = (await ctx.http().post(P()).set(accountant.auth).send(body()).expect(201)).body;
    expect(po.reference).toMatch(/^PO-\d{4}$/);
    expect(po.state).toBe('DRAFT');
    expect(po.total).toBe('6500.00');
    expect(po.matchMode).toBe('THREE_WAY');
    po = (await ctx.http().put(`${P()}/${po.id}`).set(owner.auth).send(body({ priceTolerancePercent: '2' })).expect(200)).body;
    expect(po.priceTolerancePercent).toBe('2.00');
    // A draft cannot be received or billed.
    expect((await ctx.http().post(`${P()}/${po.id}/receipts`).set(owner.auth).send({ receiptDate: T, lines: [{ orderLineId: po.lines[0].id, quantity: '1' }] }).expect(409)).body.message).toMatch(/issue it to the vendor first/);
    po = (await ctx.http().post(`${P()}/${po.id}/issue`).set(owner.auth).expect(200)).body;
    expect(po.state).toBe('ISSUED');
    expect(po.late).toBe(true);
    expect(po.toReceive).toBe('6500.00');
    expect((await ctx.http().put(`${P()}/${po.id}`).set(owner.auth).send(body()).expect(409)).body.message).toMatch(/can no longer change/);
    await ctx.http().delete(`${P()}/${po.id}`).set(owner.auth).expect(409);
    await expect(raw(`UPDATE purchase_orders SET total = 1, subtotal = 1, tax_total = 0 WHERE id = '${po.id}'`)).rejects.toThrow(/fixed once issued/);
    await expect(raw(`DELETE FROM purchase_order_lines WHERE order_id = '${po.id}'`)).rejects.toThrow(/fixed once issued/);
    // Lists
    const list = (await ctx.http().get(`${P()}?view=to_receive`).set(viewer.auth).expect(200)).body;
    expect(list.orders.map((o: any) => o.id)).toContain(po.id);
    expect(list.totals.late).toBe(1);
    expect(list.can.manage).toBe(false);
  });

  it('records goods received, refusing more than ordered', async () => {
    const [a, b] = po.lines;
    expect((await ctx.http().post(`${P()}/${po.id}/receipts`).set(owner.auth).send({ receiptDate: T, lines: [{ orderLineId: a.id, quantity: '101' }] }).expect(422)).body.message).toBe('Line 1: only 100 more can be received (ordered 100, received 0)');
    expect((await ctx.http().post(`${P()}/${po.id}/receipts`).set(owner.auth).send({ receiptDate: addDays(T, 1), lines: [{ orderLineId: a.id, quantity: '1' }] }).expect(422)).body.message).toMatch(/future/);
    const r = (await ctx.http().post(`${P()}/${po.id}/receipts`).set(accountant.auth).send({ receiptDate: T, reference: 'DC-501', lines: [{ orderLineId: a.id, quantity: '60', rejected: '2', note: 'Two crushed' }, { orderLineId: b.id, quantity: '0' }] }).expect(201)).body;
    po = r.order;
    expect(po.state).toBe('PARTLY_RECEIVED');
    expect(po.receipts[0].reference).toMatch(/^GRN-\d{4}$/);
    expect(po.receipts[0].lines).toEqual([{ orderLineId: a.id, lineNo: 1, quantity: '60', rejected: '2', note: 'Two crushed' }]);
    expect(po.lines[0].received).toBe('60');
    expect(po.lines[0].toBill).toBe('60');
    expect(po.toBill).toBe('2400.00');
    await expect(raw(`UPDATE goods_receipt_lines SET quantity = 90 WHERE receipt_id = '${po.receipts[0].id}'`)).rejects.toThrow(/does not change/);
    await expect(raw(`DELETE FROM goods_receipts WHERE id = '${po.receipts[0].id}'`)).rejects.toThrow(/never deleted/);
  });

  it('bills what was received and posts a matching bill', async () => {
    const r = (await ctx.http().post(`${P()}/${po.id}/bill`).set(accountant.auth).send({ issueDate: T, reference: 'KP/INV/881' }).expect(201)).body;
    const doc = await bill(r.documentId);
    expect(doc.purchaseOrderId).toBe(po.id);
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({ quantity: '60', unitPrice: '40', purchaseOrderLineId: po.lines[0].id });
    const m = (await ctx.http().get(`${org.base}/purchases/bills/${doc.id}/match`).set(viewer.auth).expect(200)).body;
    expect(m.match.status).toBe('MATCHED');
    expect(m.match.order.reference).toBe(po.reference);
    await ctx.http().post(`${org.base}/purchases/documents/${doc.id}/post`).set(accountant.auth).send({}).expect(200);
    po = (await ctx.http().get(`${P()}/${po.id}`).set(owner.auth).expect(200)).body;
    expect(po.lines[0].billed).toBe('60');
    expect(po.lines[0].toBill).toBe('0');
    expect(po.bills).toEqual([expect.objectContaining({ id: doc.id, status: 'POSTED', vendorInvoice: 'KP/INV/881', match: 'MATCHED' })]);
    // Nothing left that was received.
    expect((await ctx.http().post(`${P()}/${po.id}/bill`).set(owner.auth).send({ issueDate: T }).expect(422)).body.message).toMatch(/record the goods received first/);
  });

  it('blocks a bill that does not match until an approver accepts the differences', async () => {
    // The vendor bills 30 more cartons (only 60 received, all billed) at a higher price, plus freight.
    const draft = (
      await ctx.http().post(`${org.base}/purchases/documents`).set(accountant.auth).send({
        kind: 'BILL', contactId: vendor, issueDate: T, reference: 'KP/INV/902', purchaseOrderId: po.id,
        lines: [
          { accountId: org.acc['6600'], description: 'Packing cartons', quantity: '30', unitPrice: '42', purchaseOrderLineId: po.lines[0].id },
          { accountId: org.acc['6600'], description: 'Freight', quantity: '1', unitPrice: '500' },
        ],
      }).expect(201)
    ).body;
    // A later draft never turns the earlier posted bill into a mismatch; drafts show apart from what is billed.
    const now = (await ctx.http().get(`${P()}/${po.id}`).set(owner.auth).expect(200)).body;
    expect(now.bills.map((b: any) => b.match)).toEqual(['MATCHED', 'EXCEPTION']);
    expect(now.lines[0]).toMatchObject({ billed: '60', inDraftBills: '30' });
    let m = (await ctx.http().get(`${org.base}/purchases/bills/${draft.id}/match`).set(owner.auth).expect(200)).body.match;
    expect(m.status).toBe('EXCEPTION');
    expect(m.lines.map((l: any) => l.exceptions.map((e: any) => e.code))).toEqual([['PRICE_ABOVE_ORDER', 'MORE_THAN_RECEIVED'], ['NOT_ON_ORDER']]);
    const refused = (await ctx.http().post(`${org.base}/purchases/documents/${draft.id}/post`).set(owner.auth).send({}).expect(409)).body;
    expect(refused.error).toBe('BILL_MATCH_EXCEPTION');
    expect(refused.message).toMatch(/does not match PO-\d{4}: Line 1: price 42 is above the order price 40; Line 1: billing 90 in all against 60 received; Line 2 is not on the purchase order/);
    // Accountants cannot accept differences; approvers can, with a reason.
    await ctx.http().post(`${org.base}/purchases/bills/${draft.id}/match/accept`).set(accountant.auth).send({ reason: 'ok' }).expect(403);
    expect((await ctx.http().post(`${org.base}/purchases/bills/${draft.id}/match/accept`).set(approver.auth).send({ reason: ' ' }).expect(400)).body.error).toBeDefined();
    m = (await ctx.http().post(`${org.base}/purchases/bills/${draft.id}/match/accept`).set(approver.auth).send({ reason: 'Price rise agreed by phone; 30 cartons arriving tomorrow' }).expect(200)).body.match;
    expect(m.accepted).toMatchObject({ reason: 'Price rise agreed by phone; 30 cartons arriving tomorrow', acceptedBy: 'PO Approver' });
    await ctx.http().post(`${org.base}/purchases/bills/${draft.id}/match/accept`).set(approver.auth).send({ reason: 'again' }).expect(422);
    // Changing the bill changes the differences: the acceptance no longer applies.
    const lines = [{ accountId: org.acc['6600'], description: 'Packing cartons', quantity: '30', unitPrice: '45', purchaseOrderLineId: po.lines[0].id }];
    await ctx.http().put(`${org.base}/purchases/documents/${draft.id}`).set(accountant.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, reference: 'KP/INV/902', purchaseOrderId: po.id, lines }).expect(200);
    m = (await ctx.http().get(`${org.base}/purchases/bills/${draft.id}/match`).set(owner.auth).expect(200)).body.match;
    expect(m.accepted).toBeNull();
    expect(m.acceptances).toHaveLength(1);
    await ctx.http().post(`${org.base}/purchases/documents/${draft.id}/post`).set(owner.auth).send({}).expect(409);
    // Receiving the cartons and correcting the price makes it match.
    po = (await ctx.http().post(`${P()}/${po.id}/receipts`).set(owner.auth).send({ receiptDate: T, lines: [{ orderLineId: po.lines[0].id, quantity: '30' }] }).expect(201)).body.order;
    lines[0]!.unitPrice = '40.8';
    await ctx.http().put(`${org.base}/purchases/documents/${draft.id}`).set(accountant.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, reference: 'KP/INV/902', purchaseOrderId: po.id, lines }).expect(200);
    m = (await ctx.http().get(`${org.base}/purchases/bills/${draft.id}/match`).set(owner.auth).expect(200)).body.match;
    expect(m.status).toBe('MATCHED'); // 40.8 is within the 2% price tolerance
    await ctx.http().post(`${org.base}/purchases/documents/${draft.id}/post`).set(owner.auth).send({}).expect(200);
    // A receipt that posted bills rely on cannot be cancelled.
    const second = po.receipts.find((r: any) => r.lines[0].quantity === '30');
    expect((await ctx.http().post(`${P()}/${po.id}/receipts/${second.id}/cancel`).set(owner.auth).send({ reason: 'Entered twice' }).expect(422)).body.message).toMatch(/billed against what was received/);
  });

  it('refuses links to another vendor, a draft order or a line of another order', async () => {
    const send = (extra: Record<string, unknown>) =>
      ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '1' }], ...extra });
    expect((await send({ contactId: otherVendor, purchaseOrderId: po.id }).expect(422)).body.message).toMatch(/for another vendor/);
    expect((await send({ lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '1', purchaseOrderLineId: po.lines[0].id }] }).expect(422)).body.message).toMatch(/Choose the purchase order/);
    const draft = (await ctx.http().post(P()).set(owner.auth).send(body()).expect(201)).body;
    expect((await send({ purchaseOrderId: draft.id }).expect(422)).body.message).toMatch(/still a draft/);
    expect((await send({ purchaseOrderId: po.id, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '1', purchaseOrderLineId: draft.lines[0].id }] }).expect(422)).body.message).toMatch(/not on PO-/);
    await ctx.http().delete(`${P()}/${draft.id}`).set(owner.auth).expect(204);
  });

  it('matches two-way without receipts, cancels an untouched order and closes a part-delivered one', async () => {
    let two = (await ctx.http().post(P()).set(owner.auth).send(body({ matchMode: 'TWO_WAY', expectedDate: null })).expect(201)).body;
    two = (await ctx.http().post(`${P()}/${two.id}/issue`).set(owner.auth).expect(200)).body;
    expect(two.lines[0].toBill).toBe('100');
    expect(two.toReceive).toBe('0.00');
    const r = (await ctx.http().post(`${P()}/${two.id}/bill`).set(owner.auth).send({ issueDate: T, reference: 'HP-77' }).expect(201)).body;
    expect(r.order.state).toBe('ISSUED'); // a draft bill does not make it billed
    expect(r.order.lines[0]).toMatchObject({ billed: '0', inDraftBills: '100', toBill: '0' });
    const m = (await ctx.http().get(`${org.base}/purchases/bills/${r.documentId}/match`).set(owner.auth).expect(200)).body.match;
    expect(m.status).toBe('MATCHED');
    // A draft bill must be settled before closing; billed orders are closed, not cancelled.
    expect((await ctx.http().post(`${P()}/${two.id}/close`).set(owner.auth).send({ reason: 'Done' }).expect(422)).body.message).toMatch(/draft bill/);
    expect((await ctx.http().post(`${P()}/${two.id}/cancel`).set(owner.auth).send({ reason: 'x' }).expect(422)).body.message).toMatch(/A bill is matched to this order/);
    await ctx.http().delete(`${org.base}/purchases/documents/${r.documentId}`).set(owner.auth).expect(204);
    two = (await ctx.http().post(`${P()}/${two.id}/cancel`).set(owner.auth).send({ reason: 'Vendor could not supply' }).expect(200)).body;
    expect(two.state).toBe('CANCELLED');
    await expect(raw(`UPDATE purchase_orders SET memo = 'x' WHERE id = '${two.id}'`)).rejects.toThrow(/closed or cancelled/);
    // The first order: received 90 cartons of 100, no film. Close it short.
    expect((await ctx.http().post(`${P()}/${po.id}/cancel`).set(owner.auth).send({ reason: 'x' }).expect(409)).body.message).toMatch(/close it instead/);
    po = (await ctx.http().post(`${P()}/${po.id}/close`).set(owner.auth).send({ reason: 'Vendor out of film; ten cartons not needed' }).expect(200)).body;
    expect(po.state).toBe('CLOSED');
    expect(po.toBill).toBe('0.00');
    await ctx.http().post(`${P()}/${po.id}/receipts`).set(owner.auth).send({ receiptDate: T, lines: [{ orderLineId: po.lines[1].id, quantity: '1' }] }).expect(409);
    const done = (await ctx.http().get(`${P()}?view=done`).set(owner.auth).expect(200)).body.orders.map((o: any) => o.state);
    expect(done).toEqual(expect.arrayContaining(['CLOSED', 'CANCELLED']));
  });

  it('keeps orders to their organisation and records the trail', async () => {
    await ctx.http().get(`${P()}/${po.id}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/purchases/orders/${po.id}`).set(outsider.auth).expect(404);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=purchase_order`).set(owner.auth).expect(200)).body;
    const actions = (audit.items ?? audit.events ?? audit).map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['purchase_order.created', 'purchase_order.issued', 'purchase_order.billed', 'purchase_order.closed', 'purchase_order.cancelled']));
  });
});
