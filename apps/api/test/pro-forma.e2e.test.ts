/**
 * AR-008 pro forma invoices against the real API and database: a draft worked out by the invoice
 * rules (from a quotation or entered directly), changed, issued (then fixed, also by the database),
 * turned into a draft tax invoice with the same lines; deleting or voiding that invoice frees it;
 * cancelled with a reason; it posts nothing; permissions and isolation.
 */
import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
let customer: string;
let otherCustomer: string;
let pf: any;
const P = () => `${org.base}/sales/pro-formas`;
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const body = (extra: Record<string, unknown> = {}) => ({
  contactId: customer,
  issueDate: T,
  validUntil: addDays(T, 15),
  reference: 'PO-REQ-77',
  terms: '50% advance, balance before dispatch',
  lines: [
    { accountId: org.acc['4100'], description: 'Steel racks', quantity: '4', unitPrice: '12500' },
    { accountId: org.acc['4100'], description: 'Installation', quantity: '1', unitPrice: '3000' },
  ],
  ...extra,
});

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Pro Forma Owner');
  viewer = await registerUser(ctx, 'Pro Forma Viewer');
  outsider = await registerUser(ctx, 'Pro Forma Outsider');
  org = await createOrg(ctx, owner, { name: 'Pro Forma Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Pro Forma' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Banyan Retail', isCustomer: true }).expect(201)).body.id;
  otherCustomer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Cedar Mart', isCustomer: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('pro forma invoices', () => {
  it('drafts one by the invoice rules, from a quotation or directly', async () => {
    await ctx.http().post(P()).set(viewer.auth).send(body()).expect(403);
    expect((await ctx.http().post(P()).set(owner.auth).send(body({ validUntil: addDays(T, -1) })).expect(422)).body.error).toBe('PRO_FORMA_DATES');
    const quote = (await ctx.http().post(`${org.base}/sales/quotes`).set(owner.auth).send({ contactId: customer, issueDate: T, validUntil: addDays(T, 30), lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '10' }] }).expect(201)).body;
    expect((await ctx.http().post(P()).set(owner.auth).send(body({ contactId: otherCustomer, quoteId: quote.id })).expect(422)).body.message).toMatch(/for another customer/);
    pf = (await ctx.http().post(P()).set(owner.auth).send(body({ quoteId: quote.id })).expect(201)).body;
    expect(pf).toMatchObject({ reference: 'PF-0001', state: 'DRAFT', total: '53000.00', subtotal: '53000.00', customerReference: 'PO-REQ-77', quote: { reference: 'QT-0001' }, invoice: null, contact: { name: 'Banyan Retail' } });
    expect(pf.lines.map((l: { netAmount: string }) => l.netAmount)).toEqual(['50000.00', '3000.00']);
    pf = (await ctx.http().put(`${P()}/${pf.id}`).set(owner.auth).send(body({ lines: [...body().lines, { accountId: org.acc['4100'], description: 'Freight', quantity: '1', unitPrice: '1500' }] })).expect(200)).body;
    expect(pf.total).toBe('54500.00');
    expect(pf.quote).toMatchObject({ reference: 'QT-0001' });
    // Nothing is posted.
    expect(await ctx.prisma.journalEntry.count({ where: { orgId: org.orgId } })).toBe(0);
  });

  it('issues it, after which it is fixed', async () => {
    expect((await ctx.http().post(`${P()}/${pf.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(409)).body.message).toMatch(/issue it first/);
    pf = (await ctx.http().post(`${P()}/${pf.id}/issue`).set(owner.auth).expect(200)).body;
    expect(pf.state).toBe('ISSUED');
    expect((await ctx.http().put(`${P()}/${pf.id}`).set(owner.auth).send(body()).expect(409)).body.message).toMatch(/can no longer change/);
    await ctx.http().delete(`${P()}/${pf.id}`).set(owner.auth).expect(409);
    await expect(raw(`UPDATE pro_forma_invoices SET total = 1, subtotal = 1, tax_total = 0 WHERE id = '${pf.id}'`)).rejects.toThrow(/fixed once issued/);
    await expect(raw(`DELETE FROM pro_forma_invoice_lines WHERE pro_forma_id = '${pf.id}'`)).rejects.toThrow(/fixed once issued/);
    // It prints with the organisation's invoice template, as a pro forma.
    const print = (await ctx.http().get(`${P()}/${pf.id}/print`).set(viewer.auth).expect(200)).body;
    expect(print.source).toMatchObject({ kind: 'PRO_FORMA', status: 'POSTED', number: 'PF-0001', dueDate: addDays(T, 15), total: '54500.00', buyer: { name: 'Banyan Retail' } });
    expect(print.source.lines).toHaveLength(3);
    expect(print.template.builtIn).toBe(true);
    const list = (await ctx.http().get(P()).set(viewer.auth).expect(200)).body;
    expect(list.totals).toMatchObject({ drafts: 0, awaiting: { count: 1, total: '54500.00' }, invoiced: { count: 0 } });
    expect(list.can.manage).toBe(false);
  });

  it('turns into a draft tax invoice with the same lines; deleting or voiding it frees the pro forma', async () => {
    expect((await ctx.http().post(`${P()}/${pf.id}/invoice`).set(owner.auth).send({ issueDate: addDays(T, -1) }).expect(422)).body.error).toBe('PRO_FORMA_DATES');
    let r = (await ctx.http().post(`${P()}/${pf.id}/invoice`).set(owner.auth).send({ issueDate: T, dueDate: addDays(T, 10) }).expect(201)).body;
    expect(r.proForma).toMatchObject({ state: 'INVOICED', invoice: { id: r.documentId, status: 'DRAFT' } });
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${r.documentId}`).set(owner.auth).expect(200)).body;
    expect(doc).toMatchObject({ kind: 'INVOICE', status: 'DRAFT', total: '54500.00', reference: 'PF-0001 / PO-REQ-77' });
    expect(doc.lines.map((l: { description: string }) => l.description)).toEqual(['Steel racks', 'Installation', 'Freight']);
    expect((await ctx.http().post(`${P()}/${pf.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(409)).body.message).toMatch(/already invoiced/);
    // Delete the draft invoice: free again.
    await ctx.http().delete(`${org.base}/sales/documents/${r.documentId}`).set(owner.auth).expect(204);
    expect((await ctx.http().get(`${P()}/${pf.id}`).set(owner.auth).expect(200)).body).toMatchObject({ state: 'ISSUED', invoice: null });
    // Invoice again, post, then void the invoice: free again.
    r = (await ctx.http().post(`${P()}/${pf.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(201)).body;
    await ctx.http().post(`${org.base}/sales/documents/${r.documentId}/post`).set(owner.auth).send({}).expect(200);
    expect((await ctx.http().get(P()).query({ view: 'invoiced' }).set(owner.auth).expect(200)).body.proFormas.map((x: { reference: string }) => x.reference)).toEqual(['PF-0001']);
    await ctx.http().post(`${org.base}/sales/documents/${r.documentId}/void`).set(owner.auth).send({ date: T, reason: 'Wrong price' }).expect(200);
    expect((await ctx.http().get(`${P()}/${pf.id}`).set(owner.auth).expect(200)).body).toMatchObject({ state: 'ISSUED', invoice: null });
  });

  it('cancels with a reason; drafts can be deleted; each organisation sees its own', async () => {
    expect((await ctx.http().post(`${P()}/${pf.id}/cancel`).set(owner.auth).send({ reason: ' ' }).expect(400)).body.message).toBe('Request validation failed');
    pf = (await ctx.http().post(`${P()}/${pf.id}/cancel`).set(owner.auth).send({ reason: 'Customer bought elsewhere' }).expect(200)).body;
    expect(pf).toMatchObject({ state: 'CANCELLED', cancelReason: 'Customer bought elsewhere' });
    await ctx.http().post(`${P()}/${pf.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(409);
    const draft = (await ctx.http().post(P()).set(owner.auth).send(body()).expect(201)).body;
    expect(draft.reference).toBe('PF-0002');
    await ctx.http().delete(`${P()}/${draft.id}`).set(owner.auth).expect(204);
    await ctx.http().get(`${P()}/${draft.id}`).set(owner.auth).expect(404);
    await ctx.http().get(`${P()}/${pf.id}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/sales/pro-formas/${pf.id}`).set(outsider.auth).expect(404);
    // Another organisation cannot bill this organisation's customer.
    const cross = await ctx.http().post(`${other.base}/sales/pro-formas`).set(outsider.auth).send(body());
    expect([404, 422]).toContain(cross.status);
    expect((await ctx.http().get(`${other.base}/sales/pro-formas`).query({ view: 'all' }).set(outsider.auth).expect(200)).body.proFormas).toEqual([]);
  });
});
