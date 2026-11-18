import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Duplicate files across records (DOC-018) against the real API and database: the same file on
 * another record is named when it is uploaded and listed, only records the person may see are
 * named, and the duplicates report ranks one receipt on two claims or one invoice on two bills
 * above shared evidence. Removing a copy clears it.
 */
let ctx: Ctx;
let owner: TestUser;
let asha: TestUser;
let ravi: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% synthetic ${tag}\n%%EOF\n`);
const R1 = pdf('taxi receipt');
const R2 = pdf('vendor invoice 77');
const R3 = pdf('remittance advice');
const R4 = pdf('hotel folio');

function upload(user: TestUser, entityType: string, entityId: string, body: Buffer, fileName = 'receipt.pdf') {
  return ctx.http().post(`${org.base}/attachments?entityType=${entityType}&entityId=${entityId}&fileName=${encodeURIComponent(fileName)}`).set(user.auth).set('Content-Type', 'application/pdf').send(body);
}
const claim = async (user: TestUser, title: string) => (await ctx.http().post(`${org.base}/expense-claims`).set(user.auth).send({ title, lines: [{ date: today(), accountId: org.acc['6400'], amount: '450.00' }] }).expect(201)).body.id as string;
let vendorId: string;
const bill = async (ref: string) => (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendorId, issueDate: today(), reference: ref, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '1000.00' }] }).expect(201)).body.id as string;

let c1: string, c2: string, c3: string, b1: string, b2: string, b3: string, j1: string;
let dupOnB2: string;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Dup Owner');
  asha = await registerUser(ctx, 'Asha Claimant');
  ravi = await registerUser(ctx, 'Ravi Claimant');
  viewer = await registerUser(ctx, 'Dup Viewer');
  org = await createOrg(ctx, owner, { name: 'Duplicate Files Ltd' });
  for (const [u, role] of [[asha, 'EMPLOYEE'], [ravi, 'EMPLOYEE'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  vendorId = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Supplies', isVendor: true }).expect(201)).body.id;
  c1 = await claim(asha, 'Client visit (synthetic)');
  c2 = await claim(asha, 'Client visit again (synthetic)');
  c3 = await claim(ravi, 'Ravi trip (synthetic)');
  b1 = await bill('INV-77');
  b2 = await bill('INV-77-B');
  b3 = await bill('HOTEL-1');
  j1 = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: today(), memo: 'Remittance', lines: [{ accountId: org.acc['6200'], debit: '10.00' }, { accountId: org.acc['1120'], credit: '10.00' }] }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('duplicate files across records', () => {
  it('names the other records holding the same file when it is uploaded', async () => {
    expect((await upload(asha, 'EXPENSE_CLAIM', c1, R1, 'taxi.pdf').expect(201)).body.alsoOn).toEqual([]);
    const second = (await upload(asha, 'EXPENSE_CLAIM', c2, R1, 'taxi again.pdf').expect(201)).body;
    expect(second.alsoOn).toEqual([{ entityType: 'EXPENSE_CLAIM', entityId: c1, label: expect.stringMatching(/^Expense claim .+: Client visit \(synthetic\)$/), path: `expenses/${c1}`, fileName: 'taxi.pdf' }]);
    // Ravi cannot see Asha's claims, so they are not named to him.
    expect((await upload(ravi, 'EXPENSE_CLAIM', c3, R1).expect(201)).body.alsoOn).toEqual([]);
    const listed = (await ctx.http().get(`${org.base}/attachments`).query({ entityType: 'EXPENSE_CLAIM', entityId: c1 }).set(owner.auth).expect(200)).body;
    expect(listed[0].alsoOn.map((x: { entityId: string }) => x.entityId).sort()).toEqual([c2, c3].sort());
  });

  it('ranks spending supported twice above shared evidence', async () => {
    await upload(owner, 'DOCUMENT', b1, R2, 'inv 77.pdf').expect(201);
    dupOnB2 = (await upload(owner, 'DOCUMENT', b2, R2, 'inv 77 copy.pdf').expect(201)).body.id;
    await upload(owner, 'DOCUMENT', b3, R4, 'folio.pdf').expect(201);
    await upload(asha, 'EXPENSE_CLAIM', c2, R4, 'folio.pdf').expect(201);
    await upload(owner, 'DOCUMENT', b3, R3, 'remittance.pdf').expect(201);
    await upload(owner, 'JOURNAL_ENTRY', j1, R3, 'remittance.pdf').expect(201);
    const r = (await ctx.http().get(`${org.base}/attachments/duplicates`).set(owner.auth).expect(200)).body;
    expect(r.summary).toEqual({ groups: 4, high: 2, medium: 1 });
    expect(r.items.map((g: { risk: string; files: unknown[] }) => [g.risk, g.files.length])).toEqual([['HIGH', 2], ['HIGH', 3], ['MEDIUM', 2], ['LOW', 2]]);
    expect(r.items[0].reason).toMatch(/more than one bill/);
    expect(r.items[1].reason).toMatch(/more than one expense claim/);
    expect(r.items[2].files.map((f: { label: string }) => f.label).sort()).toEqual([expect.stringMatching(/^Bill /), expect.stringMatching(/^Expense claim /)].sort());
    expect(r.items[3].files.map((f: { path: string }) => f.path)).toEqual([`purchases/bills/${b3}`, `journals/${j1}`]);
  });

  it('is for people who read reports, and clears when a copy is removed', async () => {
    await ctx.http().get(`${org.base}/attachments/duplicates`).set(asha.auth).expect(403);
    expect((await ctx.http().get(`${org.base}/attachments/duplicates`).set(viewer.auth).expect(200)).body.summary.groups).toBe(4);
    await ctx.http().post(`${org.base}/attachments/${dupOnB2}/remove`).set(owner.auth).send({ reason: 'Attached to the wrong bill' }).expect(200);
    const r = (await ctx.http().get(`${org.base}/attachments/duplicates`).set(owner.auth).expect(200)).body;
    expect(r.summary).toEqual({ groups: 3, high: 1, medium: 1 });
  });
});
