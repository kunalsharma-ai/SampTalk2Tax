import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AUDIT-005: transaction history against the real API and database. A bill's life (drafted,
 * changed, posted, paid in part, a file attached, a payment unapplied) and a payment's are read
 * back from the audit trail with what hangs off them, in words, oldest first; an event altered in
 * the database shows as altered.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let billId: string;
let paymentId: string;
let fileId: string;

type History = { label: string; status: string; summary: { events: number; people: number; tampered: string[] }; events: { id: string; title: string; relation: string; actor: string; action: string; facts: { key: string; value: string }[]; changes: unknown[]; intact: boolean; entityId: string }[] };
const history = async (kind: string, id: string, user = owner) => (await ctx.http().get(`${org.base}/transaction-history/${kind}/${id}`).set(user.auth).expect(200)).body as History;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'History Owner');
  approver = await registerUser(ctx, 'History Approver');
  viewer = await registerUser(ctx, 'History Viewer');
  org = await createOrg(ctx, owner, { name: 'Transaction History Pvt Ltd' });
  for (const [u, role] of [[approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Steel Co', isVendor: true }).expect(201)).body.id;
  const lines = (price: string) => [{ accountId: org.acc['6600'], description: 'Synthetic steel rods', quantity: '1', unitPrice: price }];
  billId = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, dueDate: T, reference: 'SSC/88', lines: lines('9000.00') }).expect(201)).body.id;
  await ctx.http().put(`${org.base}/purchases/documents/${billId}`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, dueDate: T, reference: 'SSC/88', lines: lines('12000.00') }).expect(200);
  await ctx.http().post(`${org.base}/purchases/documents/${billId}/post`).set(owner.auth).send({}).expect(200);
  paymentId = (await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: vendor, date: T, bankAccountId: org.acc['1120'], amount: '5000.00', reference: 'UTR-HIST-1', allocations: [{ documentId: billId, amount: '5000.00' }] }).expect(201)).body.id;
  fileId = (await ctx.http().post(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}&fileName=ssc-88.pdf`).set(owner.auth).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4\n% synthetic steel invoice 88\n%%EOF\n')).expect(201)).body.id;
  const doc = (await ctx.http().get(`${org.base}/purchases/documents/${billId}`).set(owner.auth).expect(200)).body;
  await ctx.http().post(`${org.base}/purchases/allocations/${doc.allocations[0].id}/remove`).set(owner.auth).send({}).expect(200);
});
afterAll(async () => ctx?.app.close());

describe('transaction history', () => {
  it("tells a bill's life from the audit trail, with money applied and files", async () => {
    const h = await history('document', billId);
    expect(h.label).toMatch(/^bill /);
    expect(h.status).toBe('POSTED');
    const titles = h.events.map((e) => [e.title, e.relation]);
    expect(titles.slice(0, 4)).toEqual([['Draft created', 'RECORD'], ['Draft changed', 'RECORD'], ['Journal entry posted', 'JOURNAL'], ['Posted to the books', 'RECORD']]);
    expect(titles).toEqual(expect.arrayContaining([['Money applied', 'ALLOCATION'], ['Money unapplied', 'ALLOCATION'], ['File attached', 'FILE']]));
    const posted = h.events.find((e) => e.action === 'document.posted')!;
    expect(posted.facts).toEqual(expect.arrayContaining([{ key: 'total', value: '12000' }]));
    expect(posted.actor).toBe('History Owner');
    expect(h.events.find((e) => e.action === 'attachment.added')!.facts).toEqual([{ key: 'fileName', value: 'ssc-88.pdf' }]);
    expect(h.events.every((e) => e.intact)).toBe(true);
    expect(h.summary).toMatchObject({ people: 1, tampered: [] });
    // Oldest first, in the trail's own order.
    const ids = h.events.map((e) => BigInt(e.id));
    expect([...ids].sort((a, b) => (a < b ? -1 : 1))).toEqual(ids);
  });

  it("tells a payment's life, including the money it applied", async () => {
    const h = await history('payment', paymentId, approver);
    expect(h.label).toMatch(/^payment /);
    expect(h.events.slice(0, 2).map((e) => [e.title, e.relation])).toEqual([['Journal entry posted', 'JOURNAL'], ['Payment recorded', 'RECORD']]);
    expect(h.events.filter((e) => e.relation === 'ALLOCATION').map((e) => e.title)).toEqual(expect.arrayContaining(['Money applied']));
  });

  it('shows an event altered in the database as altered', async () => {
    const before = await history('document', billId);
    const ev = before.events.find((e) => e.action === 'attachment.added')!;
    const coll = ctx.db.collection('audit_events');
    const raw = await coll.findOne({ action: 'attachment.added', entityId: fileId });
    expect(raw).toBeTruthy();
    await coll.updateOne({ _id: raw!._id }, { $set: { 'data.fileName': 'swapped.pdf' } });
    const after = await history('document', billId);
    expect(after.events.find((e) => e.id === ev.id)!.intact).toBe(false);
    expect(after.summary.tampered).toEqual([ev.id]);
  });

  it('is for those who read the audit trail, in their own organisation', async () => {
    await ctx.http().get(`${org.base}/transaction-history/document/${billId}`).set(viewer.auth).expect(403);
    await ctx.http().get(`${org.base}/transaction-history/invoice/${billId}`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/transaction-history/document/00000000-0000-4000-8000-000000000000`).set(owner.auth).expect(404);
    const other = await createOrg(ctx, owner, { name: 'Other History Pvt Ltd' });
    await ctx.http().get(`${other.base}/transaction-history/document/${billId}`).set(owner.auth).expect(404);
  });
});
