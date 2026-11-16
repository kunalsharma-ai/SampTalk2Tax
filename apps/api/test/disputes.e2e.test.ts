/**
 * AR-025 invoice disputes against the real API and database: raised on a posted invoice for the
 * amount in question (checked against what is still due, one open at a time); changed, noted and
 * assigned with every step in the history; resolved by a credit note of the same customer or
 * another outcome, after which it is final; the summary; permissions, isolation and the database
 * guards.
 */
import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const c: Record<string, string> = {};
const inv: Record<string, { id: string; number: string }> = {};
const S = () => `${org.base}/sales/disputes`;
const raw = (sql: string) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql);
  });
const doc = async (kind: 'INVOICE' | 'CREDIT_NOTE', who: string, amount: string, post = true) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind, contactId: c[who], issueDate: addDays(T, -20), dueDate: addDays(T, -5), post, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body as { id: string; number: string };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Dispute Owner');
  viewer = await registerUser(ctx, 'Dispute Viewer');
  outsider = await registerUser(ctx, 'Dispute Outsider');
  org = await createOrg(ctx, owner, { name: 'Dispute Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Disputes' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const name of ['Banyan Retail', 'Cedar Mart']) c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id;
  inv.a = await doc('INVOICE', 'Banyan Retail', '10000');
  inv.b = await doc('INVOICE', 'Cedar Mart', '4000');
  inv.draft = await doc('INVOICE', 'Banyan Retail', '50', false);
});
afterAll(async () => {
  await ctx.app.close();
});

let d1: any;
describe('invoice disputes', () => {
  it('raises a dispute for part of an invoice, one open at a time', async () => {
    await ctx.http().post(S()).set(viewer.auth).send({ documentId: inv.a.id, reason: 'PRICE', description: 'x' }).expect(403);
    expect((await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.a.id, amount: '10000.01', reason: 'PRICE', description: 'Rate' }).expect(422)).body.message).toBe('The disputed amount is more than the 10000.00 INR still due on the invoice');
    expect((await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.a.id, reason: 'PRICE', description: 'Rate', targetDate: addDays(T, -1) }).expect(422)).body.error).toBe('DISPUTE_INVALID');
    expect((await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.draft.id, reason: 'PRICE', description: 'Rate' }).expect(409)).body.message).toMatch(/posted invoice/);
    expect((await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.a.id, reason: 'PRICE', description: 'Rate', ownerId: outsider.id }).expect(422)).body.message).toMatch(/member/);
    d1 = (await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.a.id, amount: '2500', reason: 'PRICE', description: 'Billed at 1,000 a unit; agreed 750', ownerId: viewer.id, targetDate: addDays(T, 7) }).expect(201)).body;
    expect(d1).toMatchObject({ ref: 'DS-0001', status: 'OPEN', amount: '2500.00', reason: 'PRICE', owner: { name: 'Dispute Viewer' }, targetDate: addDays(T, 7), openedOn: T, openedBy: 'Dispute Owner', days: 0, invoice: { number: inv.a.number, due: '10000.00' }, customer: { name: 'Banyan Retail' } });
    expect(d1.events.map((e: { kind: string }) => e.kind)).toEqual(['RAISED']);
    expect((await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.a.id, reason: 'QUANTITY', description: 'Again' }).expect(409)).body.message).toBe('DS-0001 is already open on this invoice');
    // Without an amount: all that is still due.
    const d2 = (await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.b.id, reason: 'NOT_RECEIVED', description: 'Goods never arrived' }).expect(201)).body;
    expect(d2).toMatchObject({ ref: 'DS-0002', amount: '4000.00', owner: null });
  });

  it('changes, notes and lists disputes with a summary', async () => {
    let d = (await ctx.http().put(`${S()}/${d1.id}`).set(owner.auth).send({ amount: '3000', reason: 'PRICE', description: 'Billed at 1,000 a unit; agreed 700', ownerId: owner.id, targetDate: addDays(T, 7) }).expect(200)).body;
    expect(d.events[1]).toMatchObject({ kind: 'CHANGED', by: 'Dispute Owner', data: { amount: { from: '2500.00', to: '3000.00' }, owner: { from: 'Dispute Viewer', to: 'Dispute Owner' } } });
    expect(Object.keys(d.events[1].data).sort()).toEqual(['amount', 'description', 'owner']);
    d = (await ctx.http().post(`${S()}/${d1.id}/notes`).set(owner.auth).send({ body: 'Called Ravi; he will send the purchase order.' }).expect(201)).body;
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(['RAISED', 'CHANGED', 'NOTE']);
    const list = (await ctx.http().get(S()).set(viewer.auth).expect(200)).body;
    expect(list.disputes.map((x: { ref: string }) => x.ref)).toEqual(['DS-0002', 'DS-0001']);
    expect(list.summary).toMatchObject({ open: 2, openAmount: '7000.00', pastTarget: 0, oldestOpenDays: 0, resolved: 0 });
    expect(list.can.manage).toBe(false);
    expect((await ctx.http().get(S()).query({ documentId: inv.a.id, status: 'all' }).set(owner.auth).expect(200)).body.disputes.map((x: { ref: string }) => x.ref)).toEqual(['DS-0001']);
  });

  it('resolves with a credit note of the same customer, then stays as it was', async () => {
    const cedarCn = await doc('CREDIT_NOTE', 'Cedar Mart', '3000');
    const draftCn = await doc('CREDIT_NOTE', 'Banyan Retail', '3000', false);
    expect((await ctx.http().post(`${S()}/${d1.id}/resolve`).set(owner.auth).send({ outcome: 'CREDIT_NOTE', note: 'Agreed 700' }).expect(422)).body.message).toBe('Choose the credit note that settles the dispute');
    expect((await ctx.http().post(`${S()}/${d1.id}/resolve`).set(owner.auth).send({ outcome: 'CREDIT_NOTE', creditNoteId: cedarCn.id, note: 'Agreed 700' }).expect(422)).body.message).toBe('The credit note is for a different customer');
    expect((await ctx.http().post(`${S()}/${d1.id}/resolve`).set(owner.auth).send({ outcome: 'CREDIT_NOTE', creditNoteId: draftCn.id, note: 'Agreed 700' }).expect(422)).body.message).toBe('The credit note must be posted');
    const cn = await doc('CREDIT_NOTE', 'Banyan Retail', '3000');
    expect((await ctx.http().get(`${S()}/${d1.id}`).set(owner.auth).expect(200)).body.creditNotes.map((x: { number: string }) => x.number)).toEqual([cn.number]);
    const d = (await ctx.http().post(`${S()}/${d1.id}/resolve`).set(owner.auth).send({ outcome: 'CREDIT_NOTE', creditNoteId: cn.id, note: 'Agreed the rate of 700 a unit' }).expect(200)).body;
    expect(d).toMatchObject({ status: 'RESOLVED', outcome: 'CREDIT_NOTE', creditNote: { number: cn.number }, resolvedOn: T, resolvedBy: 'Dispute Owner', can: { manage: false } });
    expect(d.events.at(-1)).toMatchObject({ kind: 'RESOLVED', body: 'Agreed the rate of 700 a unit' });
    expect((await ctx.http().post(`${S()}/${d1.id}/notes`).set(owner.auth).send({ body: 'More' }).expect(409)).body.error).toBe('DISPUTE_RESOLVED');
    // The customer can dispute the invoice again with a new dispute.
    const again = (await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.a.id, amount: '100', reason: 'TAX', description: 'GST rate' }).expect(201)).body;
    expect(again.ref).toBe('DS-0003');
    await ctx.http().post(`${S()}/${again.id}/resolve`).set(owner.auth).send({ outcome: 'WITHDRAWN', creditNoteId: cn.id, note: 'x' }).expect(422);
    await ctx.http().post(`${S()}/${again.id}/resolve`).set(owner.auth).send({ outcome: 'WITHDRAWN', note: 'Customer accepted the rate' }).expect(200);
    const list = (await ctx.http().get(S()).query({ status: 'resolved' }).set(owner.auth).expect(200)).body;
    expect(list.disputes.map((x: { ref: string }) => x.ref)).toEqual(['DS-0003', 'DS-0001']);
    expect(list.summary).toMatchObject({ open: 1, openAmount: '4000.00', resolved: 2, averageDaysToResolve: 0, outcomes: { CREDIT_NOTE: 1, WITHDRAWN: 1, CUSTOMER_PAYS: 0, WRITTEN_OFF: 0 } });
  });

  it('keeps each organisation to its own disputes and guards the tables', async () => {
    await ctx.http().get(`${S()}/${d1.id}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/sales/disputes/${d1.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().post(`${other.base}/sales/disputes`).set(outsider.auth).send({ documentId: inv.b.id, reason: 'PRICE', description: 'x' }).expect(404)).body.message).toBe('Invoice not found');
    expect((await ctx.http().get(`${other.base}/sales/disputes`).set(outsider.auth).expect(200)).body.disputes).toEqual([]);
    await expect(raw(`UPDATE invoice_disputes SET description = 'rewritten' WHERE id = '${d1.id}'`)).rejects.toThrow(/A resolved dispute cannot be changed/);
    await expect(raw(`UPDATE invoice_dispute_events SET body = 'rewritten' WHERE dispute_id = '${d1.id}'`)).rejects.toThrow(/history cannot be changed/);
    await expect(raw(`UPDATE invoice_disputes SET contact_id = '${c['Banyan Retail']}' WHERE document_id = '${inv.b.id}' AND status = 'OPEN'`)).rejects.toThrow(/stays on the invoice/);
  });
});
