import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * EXP-021: missing receipt detection on expense claims against the real API and database. Claims
 * that went in without a receipt are listed with why each matters (the policy's "receipt above"
 * amount, a category that always needs one, or none attached); finance asks the claimant for it,
 * the claimant sees the request, and attaching a receipt answers it.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let employee: TestUser;
let approver: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const id: Record<string, string> = {};
let hotels: string;

const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% synthetic ${tag}\n%%EOF\n`);
const post = (path: string, user: TestUser, body: object) => ctx.http().post(`${org.base}${path}`).set(user.auth).send(body);
const attach = (user: TestUser, claimId: string, tag: string) => ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_CLAIM&entityId=${claimId}&fileName=${tag}.pdf`).set(user.auth).set('Content-Type', 'application/pdf').send(pdf(tag)).expect(201);
async function claim(key: string, who: TestUser, lines: object[], opts: { receipt?: boolean; submit?: boolean; approve?: boolean } = {}) {
  const c = (await post('/expense-claims', who, { title: `Synthetic ${key}`, lines }).expect(201)).body;
  id[key] = c.id;
  id[`${key}#`] = c.number;
  if (opts.receipt) await attach(who, c.id, `receipt-${key}`);
  if (opts.submit !== false) await post(`/expense-claims/${c.id}/submit`, who, {}).expect(200);
  if (opts.approve) await post(`/expense-claims/${c.id}/approve`, who === approver ? owner : approver, { note: 'Synthetic: receipt to follow' }).expect(200);
}
const report = async (user = accountant) => (await ctx.http().get(`${org.base}/expense-claims-missing-receipts`).set(user.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Receipts Owner');
  accountant = await registerUser(ctx, 'Receipts Accountant');
  employee = await registerUser(ctx, 'Receipts Employee');
  approver = await registerUser(ctx, 'Receipts Approver');
  viewer = await registerUser(ctx, 'Receipts Viewer');
  org = await createOrg(ctx, owner, { name: 'Missing Receipts Pvt Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [employee, 'EMPLOYEE'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await post('/expense-policy-rules', owner, { kind: 'RECEIPT_ABOVE', severity: 'WARN', amount: '500' }).expect(201);
  await post('/expense-policy-rules', owner, { kind: 'RECEIPT_ABOVE', severity: 'WARN', amount: '2000' }).expect(201);
  hotels = (await post('/expense-categories', owner, { name: 'Hotels', accountId: org.acc['6700'], receipt: 'POLICY' }).expect(201)).body.id;
  // Employees now pick categories; the owner may still claim to an account.
  await claim('A', employee, [{ date: T, categoryId: hotels, merchant: 'Synthetic Inn', amount: '800.00' }], { approve: true });
  await claim('B', employee, [{ date: T, categoryId: hotels, merchant: 'Synthetic Lodge', amount: '200.00' }]);
  await claim('C', employee, [{ date: T, categoryId: hotels, merchant: 'Synthetic Stay', amount: '900.00' }], { receipt: true });
  await claim('D', owner, [{ date: T, accountId: org.acc['6700'], merchant: 'Synthetic Cabs', amount: '120.00' }]);
  await claim('E', employee, [{ date: T, categoryId: hotels, amount: '999.00' }], { submit: false });
  // Hotels starts always needing a receipt after B went in.
  await ctx.http().put(`${org.base}/expense-categories/${hotels}`).set(owner.auth).send({ name: 'Hotels', accountId: org.acc['6700'], receipt: 'ALWAYS' }).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('finding claims without receipts', () => {
  it('lists claims that went in without a receipt, required ones first', async () => {
    const r = await report();
    expect(r).toMatchObject({ days: 90, receiptAbove: '500.00', checked: 4, missing: 3, required: 2, amount: '1120.00', requiredAmount: '1000.00', canAsk: true });
    expect(r.items.map((x: { number: string; reasons: string[]; amount: string; status: string; claimant: string }) => [x.number, x.reasons, x.amount, x.status, x.claimant])).toEqual([
      [id['A#'], ['POLICY', 'CATEGORY'], '800.00', 'APPROVED', 'Receipts Employee'],
      [id['B#'], ['CATEGORY'], '200.00', 'SUBMITTED', 'Receipts Employee'],
      [id['D#'], ['NONE'], '120.00', 'SUBMITTED', 'Receipts Owner'],
    ]);
    expect(r.byClaimant.map((p: { claimant: string; claims: number; amount: string; required: number }) => [p.claimant, p.claims, p.amount, p.required])).toEqual([
      ['Receipts Employee', 2, '1000.00', 2],
      ['Receipts Owner', 1, '120.00', 0],
    ]);
  });

  it('is for those who see every claim', async () => {
    await ctx.http().get(`${org.base}/expense-claims-missing-receipts`).set(employee.auth).expect(403);
    expect((await report(viewer)).canAsk).toBe(false);
    await ctx.http().get(`${org.base}/expense-claims-missing-receipts?days=3`).set(accountant.auth).expect(400);
  });
});

describe('asking for a receipt', () => {
  it('records the request, and refuses to ask twice in a day or about a claim with a receipt', async () => {
    await post(`/expense-claims/${id.A}/receipt-requests`, viewer, {}).expect(403);
    await post(`/expense-claims/${id.A}/receipt-requests`, approver, {}).expect(403);
    const r = (await post(`/expense-claims/${id.A}/receipt-requests`, accountant, { note: 'The Synthetic Inn folio, please.' }).expect(201)).body;
    expect(r.answered).toBe(false);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({ by: 'Receipts Accountant', note: 'The Synthetic Inn folio, please.' });
    expect([null, true, false]).toContain(r.requests[0].emailed);
    const again = await post(`/expense-claims/${id.A}/receipt-requests`, owner, {}).expect(409);
    expect(again.body.error).toBe('ASKED_RECENTLY');
    expect((await post(`/expense-claims/${id.C}/receipt-requests`, accountant, {}).expect(409)).body.error).toBe('HAS_RECEIPT');
    expect((await post(`/expense-claims/${id.E}/receipt-requests`, accountant, {}).expect(409)).body.error).toBe('NOT_SUBMITTED');
    expect((await post(`/expense-claims/${id.D}/receipt-requests`, owner, {}).expect(422)).body.error).toBe('OWN_CLAIM');
    const listed = (await report()).items.find((x: { id: string }) => x.id === id.A);
    expect(listed.asked).toMatchObject({ by: 'Receipts Accountant', times: 1 });
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'expense_claim.receipt_requested', entityId: id.A } });
    expect((audit!.data as { number: string; note: string }).note).toBe('The Synthetic Inn folio, please.');
  });

  it('shows the request to the claimant, and attaching a receipt answers it', async () => {
    const mine = (await ctx.http().get(`${org.base}/expense-claims/${id.A}/receipt-requests`).set(employee.auth).expect(200)).body;
    expect(mine.requests.map((x: { note: string }) => x.note)).toEqual(['The Synthetic Inn folio, please.']);
    expect(mine.requests[0].emailError).toBeNull();
    // Someone else's claim is not theirs to read.
    await ctx.http().get(`${org.base}/expense-claims/${id.D}/receipt-requests`).set(employee.auth).expect(404);
    // The claim is approved, but the claimant may add the receipt they were asked for.
    expect((await ctx.http().get(`${org.base}/expense-claims/${id.A}`).set(employee.auth).expect(200)).body.actions.attach).toBe(true);
    await attach(employee, id.A, 'inn-folio');
    expect((await ctx.http().get(`${org.base}/expense-claims/${id.A}`).set(employee.auth).expect(200)).body.actions.attach).toBe(false);
    // Once it is there, it cannot be taken off again.
    const files = (await ctx.http().get(`${org.base}/attachments?entityType=EXPENSE_CLAIM&entityId=${id.A}`).set(employee.auth).expect(200)).body;
    const fileId = (Array.isArray(files) ? files : files.items)[0].id;
    await post(`/attachments/${fileId}/remove`, employee, { reason: 'Synthetic: wrong file' }).expect(403);
    expect((await ctx.http().get(`${org.base}/expense-claims/${id.A}/receipt-requests`).set(employee.auth).expect(200)).body.answered).toBe(true);
    const r = await report();
    expect(r.items.map((x: { number: string }) => x.number)).toEqual([id['B#'], id['D#']]);
    expect(r).toMatchObject({ missing: 2, required: 1 });
  });

  it('keeps requests to their organisation', async () => {
    const other = await createOrg(ctx, owner, { name: 'Other Receipts Pvt Ltd' });
    expect((await ctx.http().get(`${other.base}/expense-claims-missing-receipts`).set(owner.auth).expect(200)).body.items).toEqual([]);
    await ctx.http().post(`${other.base}/expense-claims/${id.B}/receipt-requests`).set(owner.auth).send({}).expect(404);
  });
});
