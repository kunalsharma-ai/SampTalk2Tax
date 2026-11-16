import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Vendor portal (AP-013) against the real API and database: staff make and revoke a private link
 * for a vendor; the vendor sees only their own posted bills, payments, issued orders and
 * statement; sends an invoice with a file; duplicates are refused; staff record it against a
 * bill (the file is attached to the bill) or turn it down with a reason the vendor sees.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let vendor: { id: string };
let otherVendor: { id: string };
let token: string;
let linkId: string;
const ids: Record<string, string> = {};
const T = today();
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const L = (c = vendor.id) => `${org.base}/contacts/${c}/vendor-portal-links`;
const V = () => `${org.base}/purchases/vendor-invoices`;
const portal = (t = token, path = '') => ctx.http().get(`/v1/vendor-portal/${t}${path}`);
const send = (body: Record<string, unknown>, t = token) => ctx.http().post(`/v1/vendor-portal/${t}/invoices`).send(body);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const bill = async (contactId: string, amount: string, issueDate: string, reference: string, post = true) =>
  (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId, issueDate, dueDate: addDays(issueDate, 30), reference, post, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: amount }] }).expect(201)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Vendor Portal Owner');
  viewer = await registerUser(ctx, 'Vendor Portal Viewer');
  org = await createOrg(ctx, owner, { name: 'Harbour Buying Co' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Kestrel Packaging', isVendor: true }).expect(201)).body;
  otherVendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Heron Plastics', isVendor: true }).expect(201)).body;
  ids.old = (await bill(vendor.id, '20000.00', addDays(T, -45), 'KP/1001')).id;
  ids.recent = (await bill(vendor.id, '8000.00', addDays(T, -5), 'KP/1002')).id;
  ids.draft = (await bill(vendor.id, '999.00', T, 'KP/DRAFT', false)).id;
  ids.others = (await bill(otherVendor.id, '7777.00', T, 'HP/1')).id;
  await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: vendor.id, date: T, bankAccountId: org.acc['1120'], amount: '15000.00', reference: 'UTR 99812', allocations: [{ documentId: ids.old, amount: '15000.00' }] }).expect(201);
  const po = (await ctx.http().post(`${org.base}/purchases/orders`).set(owner.auth).send({ contactId: vendor.id, orderDate: addDays(T, -3), reference: 'VQ-77', lines: [{ accountId: org.acc['6600'], description: 'Cartons', quantity: '100', unitPrice: '40' }] }).expect(201)).body;
  await ctx.http().post(`${org.base}/purchases/orders/${po.id}/issue`).set(owner.auth).expect(200);
  ids.po = po.id;
  ids.draftPo = (await ctx.http().post(`${org.base}/purchases/orders`).set(owner.auth).send({ contactId: vendor.id, orderDate: T, lines: [{ accountId: org.acc['6600'], description: 'Tape', quantity: '1', unitPrice: '10' }] }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('vendor portal', () => {
  it('makes, lists and revokes links; only purchases.manage can make them; the secret is not stored', async () => {
    await ctx.http().post(L()).set(viewer.auth).send({ expiresInDays: 90 }).expect(403);
    const made = (await ctx.http().post(L()).set(owner.auth).send({ expiresInDays: 90, note: 'Sent to accounts@kestrel' }).expect(201)).body;
    expect(made.token).toMatch(/^t2tv_[A-Za-z0-9]{40}$/);
    expect(made.path).toBe(`/vendor-portal/${made.token}`);
    token = made.token;
    linkId = made.id;
    const list = (await ctx.http().get(L()).set(viewer.auth).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ prefix: token.slice(5, 13), state: 'ACTIVE', note: 'Sent to accounts@kestrel', createdBy: 'Vendor Portal Owner' });
    expect(JSON.stringify(list)).not.toContain(token);
    const [row] = await ctx.prisma.$queryRawUnsafe<{ token_hash: string }[]>(`SELECT token_hash FROM vendor_portal_links WHERE id = $1::uuid`, linkId);
    expect(row!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    const audit = await ctx.prisma.$queryRawUnsafe<{ data: unknown }[]>(`SELECT data FROM audit_events WHERE entity_id = $1`, linkId);
    expect(JSON.stringify(audit)).not.toContain(token.slice(13));
    // A customer link token never opens the vendor portal, and a customer cannot get a vendor link.
    const cust = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Only A Customer', isCustomer: true }).expect(201)).body;
    await ctx.http().post(L(cust.id)).set(owner.auth).send({ expiresInDays: 30 }).expect(404);
    await portal(`t2tp_${token.slice(5)}`).expect(404);
  });

  it('shows the vendor only their own posted bills, payments, issued orders and statement', async () => {
    const p = (await portal().expect(200)).body;
    expect(p.vendor.name).toBe('Kestrel Packaging');
    expect(p.from.tradeName).toBe('Harbour Buying Co');
    expect(p.bills.map((b: { id: string }) => b.id).sort()).toEqual([ids.old, ids.recent].sort());
    const old = p.bills.find((b: { id: string }) => b.id === ids.old);
    expect(old).toMatchObject({ yourReference: 'KP/1001', total: '20000.00', open: '5000.00', state: 'PART_PAID' });
    expect(p.bills.find((b: { id: string }) => b.id === ids.recent)).toMatchObject({ open: '8000.00', state: 'TO_BE_PAID', dueDate: addDays(addDays(T, -5), 30) });
    expect(p.balances).toEqual([{ currency: 'INR', owed: '13000.00', due: '5000.00', credits: '0.00', balance: '13000.00' }]);
    expect(p.payments).toHaveLength(1);
    expect(p.payments[0]).toMatchObject({ amount: '15000.00', reference: 'UTR 99812' });
    expect(p.orders.map((o: { id: string }) => o.id)).toEqual([ids.po]);
    expect(p.orders[0]).toMatchObject({ reference: expect.stringMatching(/^PO-/), yourReference: 'VQ-77', total: '4000.00' });
    expect(JSON.stringify(p)).not.toContain('7777');
    expect(JSON.stringify(p)).not.toContain('KP/DRAFT');
    const s = (await portal(token, `/statement?from=${addDays(T, -60)}&to=${T}`).expect(200)).body;
    expect(s.closingBalance).toBe('13000.00');
    expect(s.lines.every((l: Record<string, unknown>) => !('id' in l))).toBe(true);
    const links = (await ctx.http().get(L()).set(owner.auth).expect(200)).body;
    expect(links[0].viewCount).toBe(1);
  });

  it('takes an invoice with a file, refuses duplicates and bad input', async () => {
    const body = { invoiceNumber: 'KP/1003', invoiceDate: addDays(T, -1), amount: '4000.00', currency: 'INR', purchaseOrderId: ids.po, note: 'Cartons delivered on Monday' };
    expect((await send({ ...body, invoiceDate: addDays(T, 1) }).expect(422)).body.message).toBe('The invoice date cannot be in the future');
    expect((await send({ ...body, amount: '-5' }).expect(422)).body.message).toBe('Enter the invoice total, with at most 2 decimal places');
    expect((await send({ ...body, purchaseOrderId: ids.draftPo }).expect(422)).body.message).toBe('Choose one of your purchase orders');
    // Already a bill with that number (separators and case do not matter).
    expect((await send({ ...body, invoiceNumber: 'kp 1002' }).expect(409)).body.message).toBe('Invoice kp 1002 is already recorded by Harbour Buying Co');
    const sent = (await send(body).expect(201)).body;
    expect(sent.status).toBe('RECEIVED');
    ids.sent = sent.id;
    expect((await send(body).expect(409)).body.message).toBe('You already sent invoice KP/1003; it is waiting to be checked');
    // The file: only PDF or images, once.
    expect((await ctx.http().put(`/v1/vendor-portal/${token}/invoices/${sent.id}/file?fileName=x.pdf`).set('content-type', 'application/octet-stream').send(Buffer.from('hello')).expect(415)).body.error).toBe('UNSUPPORTED_FILE');
    await ctx.http().put(`/v1/vendor-portal/${token}/invoices/${sent.id}/file?fileName=../KP-1003.pdf`).set('content-type', 'application/pdf').send(PDF).expect(200);
    expect((await ctx.http().put(`/v1/vendor-portal/${token}/invoices/${sent.id}/file?fileName=again.pdf`).set('content-type', 'application/pdf').send(PDF).expect(409)).body.error).toBe('FILE_ALREADY_SENT');
    const p = (await portal().expect(200)).body;
    expect(p.sent[0]).toMatchObject({ invoiceNumber: 'KP/1003', status: 'RECEIVED', file: 'KP-1003.pdf', purchaseOrder: p.orders[0].reference, canAddFile: false });
    // A second invoice, without a file, to turn down.
    ids.sent2 = (await send({ invoiceNumber: 'KP/1004', invoiceDate: T, amount: '1500.50', currency: 'INR' }).expect(201)).body.id;
    // Another vendor's invoice cannot be reached through this link.
    await ctx.http().put(`/v1/vendor-portal/${token}/invoices/00000000-0000-4000-8000-000000000000/file?fileName=a.pdf`).set('content-type', 'application/pdf').send(PDF).expect(404);
    const audit = await ctx.prisma.$queryRawUnsafe<{ action: string; actor_id: string | null }[]>(`SELECT action, actor_id FROM audit_events WHERE entity_id = $1 ORDER BY id`, sent.id);
    expect(audit.map((a) => a.action)).toEqual(['vendor_portal.invoice_sent', 'vendor_portal.file_sent']);
    expect(audit.every((a) => a.actor_id === null)).toBe(true);
  });

  it('staff record one against a bill (its file goes on the bill) and turn the other down', async () => {
    const list = (await ctx.http().get(`${V()}?status=RECEIVED`).set(viewer.auth).expect(200)).body;
    expect(list.counts).toEqual({ received: 2, recorded: 0, rejected: 0 });
    expect(list.submissions.find((s: { id: string }) => s.id === ids.sent)).toMatchObject({ vendor: 'Kestrel Packaging', amount: '4000.00', file: { name: 'KP-1003.pdf', contentType: 'application/pdf' } });
    const f = await ctx.http().get(`${V()}/${ids.sent}/file`).set(viewer.auth).expect(200);
    expect(f.headers['content-type']).toBe('application/pdf');
    await ctx.http().post(`${V()}/${ids.sent}/record`).set(viewer.auth).send({ documentId: ids.recent }).expect(403);
    // The staff record the bill for KP/1003, then record the sent invoice against it.
    const b = await bill(vendor.id, '4000.00', addDays(T, -1), 'KP-1003', false);
    const choices = (await ctx.http().get(`${V()}/${ids.sent}/bills`).set(owner.auth).expect(200)).body;
    expect(choices[0]).toMatchObject({ id: b.id, matches: true, status: 'DRAFT' });
    expect((await ctx.http().post(`${V()}/${ids.sent}/record`).set(owner.auth).send({ documentId: ids.others }).expect(422)).body.message).toBe('That bill is for another vendor');
    const rec = (await ctx.http().post(`${V()}/${ids.sent}/record`).set(owner.auth).send({ documentId: b.id }).expect(200)).body;
    expect(rec).toMatchObject({ status: 'RECORDED', decidedBy: 'Vendor Portal Owner', bill: { id: b.id, reference: 'KP-1003' } });
    const files = (await ctx.http().get(`${org.base}/attachments?entityType=DOCUMENT&entityId=${b.id}`).set(owner.auth).expect(200)).body;
    expect(files.map((x: { fileName: string }) => x.fileName)).toEqual(['KP-1003.pdf']);
    expect((await ctx.http().post(`${V()}/${ids.sent}/reject`).set(owner.auth).send({ reason: 'Changed my mind' }).expect(409)).body.message).toBe('This invoice is already recorded');
    // The same bill cannot record another sent invoice.
    expect((await ctx.http().post(`${V()}/${ids.sent2}/record`).set(owner.auth).send({ documentId: b.id }).expect(409)).body.message).toBe('That bill already records invoice KP/1003');
    await ctx.http().post(`${V()}/${ids.sent2}/reject`).set(owner.auth).send({ reason: 'No' }).expect(400);
    await ctx.http().post(`${V()}/${ids.sent2}/reject`).set(owner.auth).send({ reason: 'No purchase order for this; please quote one' }).expect(200);
    const p = (await portal().expect(200)).body;
    expect(p.sent.find((s: { id: string }) => s.id === ids.sent2)).toMatchObject({ status: 'REJECTED', rejectReason: 'No purchase order for this; please quote one' });
    expect(p.sent.find((s: { id: string }) => s.id === ids.sent)).toMatchObject({ status: 'RECORDED' });
    // A turned-down invoice can be sent again; a recorded one cannot.
    await send({ invoiceNumber: 'KP/1004', invoiceDate: T, amount: '1500.50', currency: 'INR', purchaseOrderId: ids.po }).expect(201);
    expect((await send({ invoiceNumber: 'KP/1003', invoiceDate: T, amount: '1.00', currency: 'INR' }).expect(409)).body.message).toBe('Invoice KP/1003 is already recorded by Harbour Buying Co');
    // Sent invoices stay as sent.
    await expect(ctx.prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass','on',true)`); await tx.$executeRawUnsafe(`UPDATE vendor_portal_submissions SET amount = 1 WHERE id = $1::uuid`, ids.sent); })).rejects.toThrow(/stays as it was sent/);
    await expect(ctx.prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass','on',true)`); await tx.$executeRawUnsafe(`DELETE FROM vendor_portal_submissions WHERE id = $1::uuid`, ids.sent2); })).rejects.toThrow(/never deleted/);
  });

  it('refuses revoked and made-up links', async () => {
    await ctx.http().post(`${L()}/${linkId}/revoke`).set(owner.auth).expect(200);
    expect((await portal().expect(404)).body.message).toBe('Harbour Buying Co has withdrawn this link. Ask them for a new one.');
    await send({ invoiceNumber: 'KP/2000', invoiceDate: T, amount: '1.00', currency: 'INR' }).expect(404);
    await portal(`t2tv_${'A'.repeat(40)}`).expect(404);
    await portal('nonsense').expect(404);
    await ctx.http().post(`${L()}/${linkId}/revoke`).set(owner.auth).expect(409);
  });
});
