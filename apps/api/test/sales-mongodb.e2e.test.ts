import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInOrg } from '../src/common/tenant-context';
import { allocations, contacts, documents, payments } from '../src/db/collections/sales';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { postgresOnly } from '../src/db/mirror-writes';
import { postgresOff } from '../src/db/counters';

/** Reads the PostgreSQL copy itself (reads through the API come from MongoDB). */
const pg = () => postgresOnly(ctx.prisma);

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Sales Mongo Owner');
  org = await createOrg(ctx, owner);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Harbour Traders', isCustomer: true, creditLimit: '50000' }).expect(201)).body;
});
afterAll(async () => {
  await ctx.app.close();
});

const invoice = (unitPrice: string) => ({ kind: 'INVOICE', contactId: customer.id, issueDate: today(), lines: [{ accountId: org.acc['4100'], description: 'Consulting', quantity: '2', unitPrice }] });

// These check the PostgreSQL copy kept while both databases run, so only while PostgreSQL does.
describe.skipIf(postgresOff())('sales and purchases live in MongoDB', () => {
  it('contacts are stored in MongoDB with a decimal credit limit, and copied to PostgreSQL', async () => {
    const doc = await ctx.db.collection('contacts').findOne({ _id: customer.id as never });
    expect(doc?.creditLimit?._bsontype).toBe('Decimal128');
    expect(doc?.creditLimit.toString()).toBe('50000');
    await ctx.http().patch(`${org.base}/contacts/${customer.id}`).set(owner.auth).send({ paymentTermsDays: 45 }).expect(200);
    expect((await ctx.db.collection('contacts').findOne({ _id: customer.id as never }))?.paymentTermsDays).toBe(45);
    expect((await pg().contact.findUniqueOrThrow({ where: { id: customer.id } })).paymentTermsDays).toBe(45);
  });

  it('a draft keeps its lines inside it; editing replaces them in both databases; deleting removes both', async () => {
    const draft = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(invoice('100.00')).expect(201)).body;
    const stored = await ctx.db.collection('documents').findOne({ _id: draft.id });
    expect(stored?.status).toBe('DRAFT');
    expect(stored?.total.toString()).toBe('200');
    expect(stored?.lines).toHaveLength(1);
    await ctx.http().put(`${org.base}/sales/documents/${draft.id}`).set(owner.auth).send(invoice('150.00')).expect(200);
    const after = await ctx.db.collection('documents').findOne({ _id: draft.id });
    const copy = await pg().document.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true } });
    expect(copy.total.toFixed(2)).toBe('300.00');
    expect(copy.lines.map((l) => l.id)).toEqual((after!.lines as { id: string }[]).map((l) => l.id));
    expect(after!.lines[0].id).not.toBe(stored!.lines[0].id);
    await ctx.http().delete(`${org.base}/sales/documents/${draft.id}`).set(owner.auth).expect((r) => expect([200, 204]).toContain(r.status));
    expect(await ctx.db.collection('documents').countDocuments({ _id: draft.id })).toBe(0);
    expect(await pg().document.count({ where: { id: draft.id } })).toBe(0);
  });

  it('posting, a receipt, its allocation and voiding are all written to MongoDB first', async () => {
    const inv = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...invoice('500.00'), post: true }).expect(201)).body;
    const posted = inv.status === 'POSTED' ? inv : (await ctx.http().post(`${org.base}/sales/documents/${inv.id}/post`).set(owner.auth).send({}).expect(200)).body;
    expect((await ctx.db.collection('documents').findOne({ _id: posted.id }))?.number).toBe(posted.number);
    const rec = (
      await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: customer.id, date: today(), bankAccountId: org.acc['1120'], amount: '400.00', allocations: [{ documentId: posted.id, amount: '400.00' }] }).expect(201)
    ).body;
    const recId = rec.payment?.id ?? rec.id;
    expect((await ctx.db.collection('payments').findOne({ _id: recId }))?.amount.toString()).toBe('400');
    const al = await ctx.db.collection('allocations').findOne({ targetId: posted.id });
    expect(al?.paymentId).toBe(recId);
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${posted.id}`).set(owner.auth).expect(200)).body;
    expect(doc.amountDue).toBe('600.00');
    await ctx.http().post(`${org.base}/sales/allocations/${al!._id}/remove`).set(owner.auth).expect(200);
    expect((await ctx.db.collection('allocations').findOne({ _id: al!._id }))?.removedOn).toBeInstanceOf(Date);
    await ctx.http().post(`${org.base}/sales/payments/${recId}/void`).set(owner.auth).send({ date: today(), reason: 'Bounced' }).expect(200);
    expect((await ctx.db.collection('payments').findOne({ _id: recId }))?.status).toBe('VOID');
    await ctx.http().post(`${org.base}/sales/documents/${posted.id}/void`).set(owner.auth).send({ date: today(), reason: 'Issued in error' }).expect(200);
    expect((await ctx.db.collection('documents').findOne({ _id: posted.id }))?.status).toBe('VOID');
    expect((await pg().document.findUniqueOrThrow({ where: { id: posted.id } })).status).toBe('VOID');
  });

  it('the data layer keeps the rules the PostgreSQL constraints and triggers kept', async () => {
    const inv = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...invoice('250.00'), post: true }).expect(201)).body;
    const id = inv.status === 'POSTED' ? inv.id : (await ctx.http().post(`${org.base}/sales/documents/${inv.id}/post`).set(owner.auth).send({}).expect(200)).body.id;
    const docs = () => ctx.store.collection(documents);
    await expect(runInOrg(org.orgId, () => docs().updateOne({ id }, { $set: { total: '1' } }))).rejects.toThrow(/immutable/);
    // Staying posted, only its template may change.
    await expect(runInOrg(org.orgId, () => docs().updateOne({ id }, { $set: { memo: 'changed' } }))).rejects.toThrow(/immutable/);
    await expect(runInOrg(org.orgId, () => docs().updateOne({ id }, { $set: { templateId: null } }))).resolves.toBeTruthy();
    await expect(runInOrg(org.orgId, () => docs().deleteOne({ id }))).rejects.toThrow(/cannot be deleted/);
    // An allocation above what is due is refused, as is one from another contact.
    const rec = (await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: customer.id, date: today(), bankAccountId: org.acc['1120'], amount: '900.00', allocations: [] }).expect(201)).body;
    const recId = rec.payment?.id ?? rec.id;
    const base = { targetId: id, paymentId: recId, creditDocumentId: null, writeOffId: null, date: new Date(`${today()}T00:00:00Z`), createdById: owner.id, createdAt: new Date(), removedOn: null, removedById: null, fxGain: '0', fxJournalEntryId: null, fxReversalJournalEntryId: null };
    await expect(runInOrg(org.orgId, () => ctx.store.collection(allocations).insertOne({ ...base, amount: '600' } as never))).rejects.toThrow(/exceed the document total/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(allocations).insertOne({ ...base, amount: '0' } as never))).rejects.toThrow(/above zero/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(payments).updateOne({ id: recId }, { $set: { amount: '1' } }))).rejects.toThrow(/immutable/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(contacts).updateOne({ id: customer.id }, { $set: { isCustomer: false, isVendor: false } }))).rejects.toThrow(/customer, a vendor or both/);
  });

  it('expense claims, attachments and bank statement lines are written to MongoDB first', async () => {
    const claim = (await ctx.http().post(`${org.base}/expense-claims`).set(owner.auth).send({ title: 'Taxi (synthetic)', lines: [{ date: today(), accountId: org.acc['6600'], amount: '420.00' }] }).expect(201)).body;
    const stored = await ctx.db.collection('expense_claims').findOne({ _id: claim.id });
    expect(stored?.lines).toHaveLength(1);
    expect(stored?.total.toString()).toBe('420');
    const copy = await pg().expenseClaim.findUniqueOrThrow({ where: { id: claim.id }, include: { lines: true } });
    expect(copy.lines.map((l) => l.id)).toEqual((stored!.lines as { id: string }[]).map((l) => l.id));

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
    const att = (await ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_CLAIM&entityId=${claim.id}&fileName=taxi.pdf`).set(owner.auth).set('Content-Type', 'application/pdf').send(pdf).expect(201)).body;
    const file = await ctx.db.collection('attachments').findOne({ _id: att.id });
    expect(Buffer.from(file!.content.buffer).equals(pdf)).toBe(true);
    expect(Buffer.from((await pg().attachment.findUniqueOrThrow({ where: { id: att.id } })).content).equals(pdf)).toBe(true);

    const csv = ['Date,Narration,Ref,Amount', `${today().split('-').reverse().join('/')},Coffee beans,CB1,-250.00`].join('\n');
    await ctx.http().post(`${org.base}/banking/accounts/${org.acc['1120']}/imports`).set(owner.auth).send({ fileName: 'nov.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }).expect(201);
    const line = await ctx.db.collection('bank_statement_lines').findOne({ orgId: org.orgId, description: 'Coffee beans' });
    expect(line?.amount.toString()).toBe('-250');
    await ctx.http().post(`${org.base}/banking/lines/${line!._id}/exclude`).set(owner.auth).send({ reason: 'Personal' }).expect((r) => expect([200, 201]).toContain(r.status));
    expect((await ctx.db.collection('bank_statement_lines').findOne({ _id: line!._id }))?.status).toBe('EXCLUDED');
    expect((await pg().bankStatementLine.findUniqueOrThrow({ where: { id: line!._id as unknown as string } })).status).toBe('EXCLUDED');
  });
});
