import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * CRM slice 2 against the real API and database: quotations worked out by the invoice rules,
 * sent, revised, declined, expired and accepted into sales orders (winning their deal), orders
 * billed in parts into draft invoices, quantities freed by deleting or voiding an invoice,
 * cancellation, permissions, tenant isolation and the database guards.
 */
const T = today();
const plus = (n: number) => new Date(Date.parse(`${T}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let otherCustomer: { id: string };
let tax18: { id: string };
let dealId: string;

const raw = (sql: string) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql);
  });
const quote = (extra: Record<string, unknown> = {}) => ({
  contactId: customer.id,
  issueDate: T,
  validUntil: plus(14),
  terms: '50% on order, 50% on delivery.',
  lines: [
    { accountId: org.acc['4100'], description: 'Bookkeeping, monthly', quantity: '12', unitPrice: '15000.00', taxRateId: tax18.id },
    { accountId: org.acc['4200'], description: 'Onboarding', quantity: '1', unitPrice: '25000.00' },
  ],
  ...extra,
});

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Quote Owner');
  viewer = await registerUser(ctx, 'Quote Viewer');
  outsider = await registerUser(ctx, 'Quote Outsider');
  org = await createOrg(ctx, owner, { name: 'Quoting Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Quotes Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Nair Logistics', isCustomer: true }).expect(201)).body;
  otherCustomer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Someone Else', isCustomer: true }).expect(201)).body;
  tax18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body;
  dealId = (await ctx.http().post(`${org.base}/crm/deals`).set(owner.auth).send({ name: 'Annual books', contactId: customer.id, amount: '205000.00', expectedCloseDate: plus(20), stage: 'PROPOSAL' }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('quotations', () => {
  let qid: string;
  it('are worked out by the invoice rules and linked to their deal', async () => {
    const r = await ctx.http().post(`${org.base}/sales/quotes`).set(owner.auth).send(quote({ dealId })).expect(201);
    qid = r.body.id;
    expect(r.body).toMatchObject({ reference: 'QT-0001', state: 'DRAFT', subtotal: '205000.00', taxTotal: '32400.00', total: '237400.00', deal: { reference: 'DL-0001' } });
    expect(r.body.lines[0]).toMatchObject({ netAmount: '180000.00', taxAmount: '32400.00', tax: { name: 'Standard 18%' }, account: { code: '4100' } });
    const bad = await ctx.http().post(`${org.base}/sales/quotes`).set(owner.auth).send(quote({ lines: [{ accountId: org.acc['1200'], quantity: '1', unitPrice: '5' }] })).expect(422);
    expect(JSON.stringify(bad.body)).toContain('control account');
    expect((await ctx.http().post(`${org.base}/sales/quotes`).set(owner.auth).send(quote({ dealId, contactId: otherCustomer.id })).expect(422)).body.error).toBe('SALES_DEAL_OTHER_CUSTOMER');
    expect((await ctx.http().post(`${org.base}/sales/quotes`).set(owner.auth).send(quote({ validUntil: plus(-1) })).expect(422)).body.error).toBe('QUOTE_DATES');
  });

  it('change only as drafts, and need answering only once sent', async () => {
    const u = await ctx.http().put(`${org.base}/sales/quotes/${qid}`).set(owner.auth).send(quote({ dealId, lines: [{ accountId: org.acc['4100'], description: 'Bookkeeping, monthly', quantity: '12', unitPrice: '14000.00', taxRateId: tax18.id }] })).expect(200);
    expect(u.body.total).toBe('198240.00');
    expect((await ctx.http().post(`${org.base}/sales/quotes/${qid}/accept`).set(owner.auth).send({}).expect(422)).body.error).toBe('QUOTE_NOT_SENT');
    const s = await ctx.http().post(`${org.base}/sales/quotes/${qid}/send`).set(owner.auth).expect(200);
    expect(s.body).toMatchObject({ state: 'SENT', sentAt: expect.any(String) });
    expect((await ctx.http().put(`${org.base}/sales/quotes/${qid}`).set(owner.auth).send(quote()).expect(422)).body.error).toBe('QUOTE_NOT_DRAFT');
    await ctx.http().delete(`${org.base}/sales/quotes/${qid}`).set(owner.auth).expect(422);
    const deal = (await ctx.http().get(`${org.base}/crm/deals/${dealId}`).set(owner.auth).expect(200)).body;
    expect(deal.activities.map((a: { body: string | null }) => a.body).join('|')).toContain('Quotation QT-0001 sent: 198240.00');
  });

  it('are revised: the draft revision supersedes the original only once sent', async () => {
    const r = await ctx.http().post(`${org.base}/sales/quotes/${qid}/revise`).set(owner.auth).expect(201);
    expect(r.body).toMatchObject({ reference: 'QT-0001-R2', state: 'DRAFT', total: '198240.00' });
    expect((await ctx.http().post(`${org.base}/sales/quotes/${qid}/revise`).set(owner.auth).expect(422)).body.error).toBe('QUOTE_NOT_LATEST');
    expect((await ctx.http().post(`${org.base}/sales/quotes/${qid}/accept`).set(owner.auth).send({}).expect(422)).body.error).toBe('QUOTE_NOT_LATEST');
    // Deleting the draft revision leaves the original as it was; a new revision can then be made.
    await ctx.http().delete(`${org.base}/sales/quotes/${r.body.id}`).set(owner.auth).expect(204);
    const r2 = (await ctx.http().post(`${org.base}/sales/quotes/${qid}/revise`).set(owner.auth).expect(201)).body;
    expect(r2.reference).toBe('QT-0001-R2');
    await ctx.http().put(`${org.base}/sales/quotes/${r2.id}`).set(owner.auth).send(quote({ dealId })).expect(200);
    await ctx.http().post(`${org.base}/sales/quotes/${r2.id}/send`).set(owner.auth).expect(200);
    const orig = (await ctx.http().get(`${org.base}/sales/quotes/${qid}`).set(owner.auth).expect(200)).body;
    expect(orig.state).toBe('SUPERSEDED');
    expect(orig.revisions.map((x: { reference: string; state: string }) => `${x.reference}:${x.state}`)).toEqual(['QT-0001:SUPERSEDED', 'QT-0001-R2:SENT']);
    qid = r2.id;
  });

  it('are declined with a reason, or expire', async () => {
    const d = (await ctx.http().post(`${org.base}/sales/quotes`).set(owner.auth).send(quote({ contactId: otherCustomer.id })).expect(201)).body;
    await ctx.http().post(`${org.base}/sales/quotes/${d.id}/send`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/sales/quotes/${d.id}/decline`).set(owner.auth).send({ reason: ' ' }).expect(400);
    const dec = await ctx.http().post(`${org.base}/sales/quotes/${d.id}/decline`).set(owner.auth).send({ reason: 'Too expensive' }).expect(200);
    expect(dec.body).toMatchObject({ state: 'DECLINED', declineReason: 'Too expensive' });
    // A declined quotation can be revised; sending the revision supersedes it.
    const rv = (await ctx.http().post(`${org.base}/sales/quotes/${d.id}/revise`).set(owner.auth).expect(201)).body;
    await ctx.http().post(`${org.base}/sales/quotes/${rv.id}/send`).set(owner.auth).expect(200);
    expect((await ctx.http().get(`${org.base}/sales/quotes/${d.id}`).set(owner.auth).expect(200)).body).toMatchObject({ state: 'SUPERSEDED', declineReason: 'Too expensive' });
    // Expiry: a sent quotation past its date (dates moved back with the guard off, as time passing would).
    await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
      await tx.$executeRawUnsafe('ALTER TABLE sales_quotes DISABLE TRIGGER sales_quotes_guard');
      await tx.$executeRawUnsafe(`UPDATE sales_quotes SET issue_date = DATE '${plus(-20)}', valid_until = DATE '${plus(-1)}' WHERE id = '${rv.id}'`);
      await tx.$executeRawUnsafe('ALTER TABLE sales_quotes ENABLE TRIGGER sales_quotes_guard');
    });
    expect((await ctx.http().get(`${org.base}/sales/quotes/${rv.id}`).set(owner.auth).expect(200)).body.state).toBe('EXPIRED');
    expect((await ctx.http().post(`${org.base}/sales/quotes/${rv.id}/accept`).set(owner.auth).send({}).expect(422)).body.error).toBe('QUOTE_EXPIRED');
    expect((await ctx.http().post(`${org.base}/sales/quotes/${rv.id}/decline`).set(owner.auth).send({ reason: 'Lapsed' }).expect(200)).body.state).toBe('DECLINED');
    const list = (await ctx.http().get(`${org.base}/sales/quotes`).set(viewer.auth).expect(200)).body;
    expect(list.totals.awaiting.count).toBeGreaterThanOrEqual(1);
    expect(list.can.manage).toBe(false);
  });
});

describe('sales orders', () => {
  let orderId: string;
  let lines: { id: string; lineNo: number }[];
  it('come from an accepted quotation, which wins its deal', async () => {
    const q = (await ctx.http().get(`${org.base}/sales/quotes?status=SENT&contactId=${customer.id}`).set(owner.auth).expect(200)).body.quotes[0];
    const r = await ctx.http().post(`${org.base}/sales/quotes/${q.id}/accept`).set(owner.auth).send({ reference: 'PO-7781' }).expect(200);
    orderId = r.body.id;
    lines = r.body.lines;
    expect(r.body).toMatchObject({ reference: 'SO-0001', customerReference: 'PO-7781', total: '237400.00', toBill: '237400.00', billing: 'NOT_BILLED', quote: { reference: 'QT-0001-R2' } });
    expect((await ctx.http().get(`${org.base}/sales/quotes/${q.id}`).set(owner.auth).expect(200)).body).toMatchObject({ state: 'ACCEPTED', order: { reference: 'SO-0001' } });
    const deal = (await ctx.http().get(`${org.base}/crm/deals/${dealId}`).set(owner.auth).expect(200)).body;
    expect(deal).toMatchObject({ stage: 'WON', probability: 100, closedOn: T });
    expect(deal.activities[0].body).toContain('quotation QT-0001-R2 accepted as order SO-0001');
    await ctx.http().post(`${org.base}/sales/quotes/${q.id}/accept`).set(owner.auth).send({}).expect(422);
  });

  it('are billed in parts into draft invoices, never beyond the order', async () => {
    const tooMuch = await ctx.http().post(`${org.base}/sales/orders/${orderId}/invoices`).set(owner.auth).send({ issueDate: T, lines: [{ orderLineId: lines[0]!.id, quantity: '13' }] }).expect(422);
    expect(tooMuch.body.message).toBe('Line 1: only 12 left to bill');
    const b = await ctx.http().post(`${org.base}/sales/orders/${orderId}/invoices`).set(owner.auth).send({ issueDate: T, lines: [{ orderLineId: lines[0]!.id, quantity: '3' }, { orderLineId: lines[1]!.id, quantity: '1' }] }).expect(201);
    expect(b.body.order).toMatchObject({ billing: 'PARTLY_BILLED', toBill: '159300.00' });
    const inv = (await ctx.http().get(`${org.base}/sales/documents/${b.body.documentId}`).set(owner.auth).expect(200)).body;
    expect(inv).toMatchObject({ status: 'DRAFT', kind: 'INVOICE', reference: 'SO-0001 / PO-7781', subtotal: '70000.00', taxTotal: '8100.00', total: '78100.00' });
    // Posting it changes nothing on the order; deleting a draft frees its quantities.
    const second = await ctx.http().post(`${org.base}/sales/orders/${orderId}/invoices`).set(owner.auth).send({ issueDate: T, lines: [{ orderLineId: lines[0]!.id, quantity: '2' }] }).expect(201);
    expect(second.body.order.lines[0]).toMatchObject({ billed: '5', remaining: '7' });
    await ctx.http().delete(`${org.base}/sales/documents/${second.body.documentId}`).set(owner.auth).expect(204);
    let o = (await ctx.http().get(`${org.base}/sales/orders/${orderId}`).set(owner.auth).expect(200)).body;
    expect(o.lines[0]).toMatchObject({ billed: '3', remaining: '9' });
    await ctx.http().post(`${org.base}/sales/documents/${b.body.documentId}/post`).set(owner.auth).send({}).expect(200);
    // Bill the rest (no lines given = everything left).
    const rest = await ctx.http().post(`${org.base}/sales/orders/${orderId}/invoices`).set(owner.auth).send({ issueDate: T }).expect(201);
    expect(rest.body.order).toMatchObject({ billing: 'BILLED', toBill: '0.00' });
    expect((await ctx.http().post(`${org.base}/sales/orders/${orderId}/invoices`).set(owner.auth).send({ issueDate: T }).expect(422)).body.error).toBe('ORDER_BILLED');
    expect((await ctx.http().get(`${org.base}/sales/orders?view=open`).set(owner.auth).expect(200)).body.orders).toHaveLength(0);
    expect((await ctx.http().get(`${org.base}/sales/orders?view=billed`).set(owner.auth).expect(200)).body.orders).toHaveLength(1);
    // Voiding the posted invoice frees its quantities again.
    await ctx.http().post(`${org.base}/sales/documents/${b.body.documentId}/void`).set(owner.auth).send({ reason: 'Wrong period' }).expect(200);
    o = (await ctx.http().get(`${org.base}/sales/orders/${orderId}`).set(owner.auth).expect(200)).body;
    expect(o).toMatchObject({ billing: 'PARTLY_BILLED', toBill: '78100.00' });
    expect(o.invoices.map((i: { status: string }) => i.status).sort()).toEqual(['DRAFT', 'VOID']);
    expect((await ctx.http().post(`${org.base}/sales/orders/${orderId}/cancel`).set(owner.auth).send({ reason: 'x' }).expect(422)).body.error).toBe('ORDER_HAS_INVOICES');
  });

  it('can be entered directly and cancelled while unbilled', async () => {
    const r = await ctx.http().post(`${org.base}/sales/orders`).set(owner.auth).send({ contactId: otherCustomer.id, orderDate: T, reference: 'PO-1', lines: [{ accountId: org.acc['4100'], quantity: '2', unitPrice: '500.00', taxRateId: tax18.id }] }).expect(201);
    expect(r.body).toMatchObject({ reference: 'SO-0002', total: '1180.00' });
    const c = await ctx.http().post(`${org.base}/sales/orders/${r.body.id}/cancel`).set(owner.auth).send({ reason: 'Customer withdrew' }).expect(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer withdrew', toBill: '0.00' });
    expect((await ctx.http().post(`${org.base}/sales/orders/${r.body.id}/invoices`).set(owner.auth).send({ issueDate: T }).expect(422)).body.error).toBe('ORDER_CANCELLED');
  });
});

describe('access and guards', () => {
  it('lets viewers read only, and keeps other organisations out', async () => {
    await ctx.http().post(`${org.base}/sales/quotes`).set(viewer.auth).send(quote()).expect(403);
    await ctx.http().get(`${org.base}/sales/orders`).set(viewer.auth).expect(200);
    const mine = (await ctx.http().get(`${org.base}/sales/orders?view=all`).set(owner.auth).expect(200)).body.orders[0];
    await ctx.http().get(`${other.base}/sales/orders/${mine.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/sales/quotes`).set(outsider.auth).expect(200)).body.quotes).toEqual([]);
  });

  it('never lets an order, its lines, or an answered quotation change', async () => {
    await expect(raw(`DELETE FROM sales_orders WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE sales_order_lines SET quantity = 1 WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/never change/);
    await expect(raw(`UPDATE sales_orders SET total = 1 WHERE org_id = '${org.orgId}' AND status = 'OPEN'`)).rejects.toThrow(/keeps its customer/);
    await expect(raw(`UPDATE sales_quotes SET memo = 'x' WHERE org_id = '${org.orgId}' AND status = 'ACCEPTED'`)).rejects.toThrow(/does not change/);
    await expect(raw(`UPDATE sales_quote_lines SET quantity = 1 WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/draft quotation/);
    await expect(raw(`DELETE FROM sales_order_billings WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/draft invoice/);
  });
});
