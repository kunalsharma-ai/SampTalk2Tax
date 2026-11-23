import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * The same receipt file claimed twice (EXP-018) against the real API and database: a receipt file
 * already on another submitted claim, or on a posted supplier bill, is named on the claim for
 * approvers (not for the claimant), approving it needs a note that is kept with the approval, the
 * expense risk view raises it as serious, and drafts and rejected claims do not count.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let ravi: TestUser;
let asha: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const ids: Record<string, string> = {};
const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% synthetic ${tag}\n%%EOF\n`);
const TAXI = pdf('taxi receipt 4411');
const INVOICE = pdf('vendor invoice 77');
type Same = { fileName: string; message: string; on: { kind: string; id: string; label: string }[] }[] | null;

const upload = (user: TestUser, entityType: string, entityId: string, body: Buffer, fileName: string) =>
  ctx.http().post(`${org.base}/attachments?entityType=${entityType}&entityId=${entityId}&fileName=${fileName}`).set(user.auth).set('Content-Type', 'application/pdf').send(body).expect(201);
async function claim(key: string, who: TestUser, amount: string, file?: Buffer, submit = true) {
  const c = (await ctx.http().post(`${org.base}/expense-claims`).set(who.auth).send({ title: `Synthetic ${key}`, lines: [{ date: T, accountId: org.acc['6700'], merchant: `Synthetic Cabs ${key}`, amount }] }).expect(201)).body;
  ids[key] = c.id;
  ids[`${key}#`] = c.number;
  if (file) ids[`${key}file`] = (await upload(who, 'EXPENSE_CLAIM', c.id, file, `${key.toLowerCase()}-receipt.pdf`)).body.id;
  if (submit) await ctx.http().post(`${org.base}/expense-claims/${c.id}/submit`).set(who.auth).send({}).expect(200);
}
const view = async (key: string, user = approver) => (await ctx.http().get(`${org.base}/expense-claims/${ids[key]}`).set(user.auth).expect(200)).body as { sameReceiptFiles: Same };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Files Owner');
  approver = await registerUser(ctx, 'Files Approver');
  ravi = await registerUser(ctx, 'Ravi Twice');
  asha = await registerUser(ctx, 'Asha Again');
  org = await createOrg(ctx, owner, { name: 'Same File Traders' });
  for (const [u, role] of [[approver, 'APPROVER'], [ravi, 'EMPLOYEE'], [asha, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Cab Co', isVendor: true }).expect(201)).body.id;
  const bill = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, dueDate: T, reference: 'CAB-77', post: true, lines: [{ accountId: org.acc['6700'], description: 'Cabs', quantity: '1', unitPrice: '700.00' }] }).expect(201)).body;
  ids.bill = bill.id;
  ids['bill#'] = bill.number;
  await upload(owner, 'DOCUMENT', bill.id, INVOICE, 'cab-invoice.pdf');
  await claim('A', ravi, '640.00', TAXI);
  await claim('DRAFT', ravi, '640.00', INVOICE, false);
});
afterAll(async () => ctx?.app.close());

describe('the same receipt file claimed twice', () => {
  it('names the other claim or bill to approvers, not to the claimant', async () => {
    expect((await view('A')).sameReceiptFiles).toEqual([]);
    await claim('B', asha, '640.00', TAXI);
    await claim('C', ravi, '700.00', INVOICE);
    expect((await view('B')).sameReceiptFiles).toEqual([{ fileName: 'b-receipt.pdf', message: `b-receipt.pdf is also on ${ids['A#']}, Ravi Twice`, on: [{ kind: 'EXPENSE_CLAIM', id: ids.A, label: `${ids['A#']}, Ravi Twice` }] }]);
    expect((await view('A')).sameReceiptFiles!.map((s) => s.on.map((h) => h.id))).toEqual([[ids.B]]);
    // The bill counts; the draft with the same file does not.
    expect((await view('C')).sameReceiptFiles).toEqual([{ fileName: 'c-receipt.pdf', message: `c-receipt.pdf is also on Bill ${ids['bill#']} from Synthetic Cab Co`, on: [{ kind: 'BILL', id: ids.bill, label: `Bill ${ids['bill#']} from Synthetic Cab Co` }] }]);
    expect((await view('B', asha)).sameReceiptFiles).toBeNull();
  });

  it('needs a reason to approve, kept with the approval', async () => {
    const r = await ctx.http().post(`${org.base}/expense-claims/${ids.B}/approve`).set(approver.auth).send({}).expect(422);
    expect(r.body.error).toBe('SAME_RECEIPT_FILE_NOTE_REQUIRED');
    expect(JSON.stringify(r.body)).toContain(`b-receipt.pdf is also on ${ids['A#']}, Ravi Twice`);
    await ctx.http().post(`${org.base}/expense-claims/${ids.B}/approve`).set(approver.auth).send({ note: 'Shared taxi; Ravi claimed half, Asha the other half' }).expect(200);
    const ev = await ctx.db.collection('audit_events').findOne({ orgId: org.orgId, action: 'expense_claim.approved', entityId: ids.B });
    expect(ev?.data.sameReceiptFiles).toEqual([`b-receipt.pdf is also on ${ids['A#']}, Ravi Twice`]);
  });

  it('is serious in the expense risk view, and stops once the copy is rejected', async () => {
    const risk = async () => (await ctx.http().get(`${org.base}/expense-risk`).set(owner.auth).expect(200)).body as { items: { claim: { id: string }; level: string; indicators: { code: string; detail: string; otherClaim: { id: string } | null }[] }[]; summary: { byIndicator: Record<string, number> } };
    const r = await risk();
    const same = (id: string) => r.items.find((i) => i.claim.id === id)?.indicators.find((x) => x.code === 'SAME_RECEIPT_FILE');
    expect(same(ids.A)).toMatchObject({ otherClaim: { id: ids.B } });
    expect(same(ids.B)).toMatchObject({ otherClaim: { id: ids.A } });
    expect(same(ids.C)).toMatchObject({ detail: `c-receipt.pdf is also on Bill ${ids['bill#']} from Synthetic Cab Co`, otherClaim: null });
    expect(r.items.find((i) => i.claim.id === ids.C)!.level).toBe('HIGH');
    expect(r.summary.byIndicator.SAME_RECEIPT_FILE).toBe(3);
    await ctx.http().post(`${org.base}/expense-claims/${ids.C}/reject`).set(approver.auth).send({ note: 'The business paid this cab on the bill' }).expect(200);
    expect((await risk()).summary.byIndicator.SAME_RECEIPT_FILE).toBe(2);
  });
});
