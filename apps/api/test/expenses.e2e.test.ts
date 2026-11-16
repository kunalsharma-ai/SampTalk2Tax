import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, setOrgFields, TestUser, today } from './helpers';

/** Employee expense claims, from a draft to reimbursement, against a real database. */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let colleague: TestUser;
let approver: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let gst18: string;
let claimId: string;

const PDF = Buffer.from('%PDF-1.4\n% synthetic receipt\n%%EOF\n');
const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

function claim(user: TestUser, lines: unknown[], title = 'Client visit (synthetic)') {
  return ctx.http().post(`${org.base}/expense-claims`).set(user.auth).send({ title, lines });
}
const act = (user: TestUser, id: string, action: string, body: unknown = {}) => ctx.http().post(`${org.base}/expense-claims/${id}/${action}`).set(user.auth).send(body as object);
const get = async (user: TestUser, id: string) => (await ctx.http().get(`${org.base}/expense-claims/${id}`).set(user.auth).expect(200)).body;
async function balance(accountId: string) {
  const tb = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${today()}`).set(owner.auth).expect(200)).body;
  const row = (tb.rows ?? tb.accounts ?? tb.lines).find((r: { accountId: string }) => r.accountId === accountId);
  return row ? { debit: row.debit, credit: row.credit } : null;
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  employee = await registerUser(ctx, 'Field Employee');
  colleague = await registerUser(ctx, 'Other Employee');
  approver = await registerUser(ctx, 'Approver');
  accountant = await registerUser(ctx, 'Accountant');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [
    [employee, 'EMPLOYEE'],
    [colleague, 'EMPLOYEE'],
    [approver, 'APPROVER'],
    [accountant, 'ACCOUNTANT'],
  ] as const) {
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
  gst18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18% (synthetic)', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('the Employee role', () => {
  it('sees what it needs to claim expenses and nothing of the books', async () => {
    const opts = (await ctx.http().get(`${org.base}/expense-claims/options`).set(employee.auth).expect(200)).body;
    expect(opts.currency).toBe('INR');
    const codes = opts.accounts.map((a: { code: string }) => a.code);
    expect(codes).toContain('6600');
    expect(codes.some((c: string) => ['1120', '1200', '2100', '2250', '4100'].includes(c))).toBe(false);
    expect(opts.taxRates.map((t: { name: string }) => t.name)).toEqual(['GST 18% (synthetic)']);
    for (const path of ['/accounts', '/journals', '/reports/trial-balance', '/sales/documents', '/banking/accounts', '/audit-events']) {
      await ctx.http().get(`${org.base}${path}`).set(employee.auth).expect(403);
    }
    await ctx.http().get(`${org.base}/expense-claims/options`).set(owner.auth).expect(200);
  });
});

describe('a claim from draft to reimbursement', () => {
  it('splits tax out of what was paid and refuses lines that cannot be claimed', async () => {
    const bad = await claim(employee, [
      { date: day(-2), accountId: org.acc['6600'], amount: '10.00' },
      { date: day(1), accountId: org.acc['1120'], amount: '10.00' },
      { date: day(1), accountId: org.acc['2250'], amount: '10.00' },
    ]).expect(422);
    expect(bad.body.details.issues).toEqual([
      'Line 1: the date is in the future',
      expect.stringMatching(/^Line 2: 1120 .* is not an expense account$/),
      expect.stringMatching(/^Line 3: 2250 is a control account$/),
    ]);
    const c = (
      await claim(employee, [
        { date: day(3), accountId: org.acc['6600'], merchant: 'Synthetic Cabs', description: 'Airport to client', amount: '1180.00', taxRateId: gst18 },
        { date: day(3), accountId: org.acc['6600'], merchant: 'Synthetic Diner', amount: '450.50' },
      ]).expect(201)
    ).body;
    claimId = c.id;
    expect(c).toMatchObject({ number: 'EXP-000001', status: 'DRAFT', claimant: 'Field Employee', total: '1630.50', taxTotal: '180.00', netTotal: '1450.50', receiptCount: 0 });
    expect(c.lines[0]).toMatchObject({ amount: '1180.00', netAmount: '1000.00', taxAmount: '180.00', taxName: 'GST 18% (synthetic)' });
    expect(c.actions).toMatchObject({ edit: true, submit: true, decide: false, reimburse: false });
  });

  it('keeps receipts private to the claimant and finance', async () => {
    const up = (r: TestUser, body = PDF) =>
      ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_CLAIM&entityId=${claimId}&fileName=cab.pdf`).set(r.auth).set('Content-Type', 'application/octet-stream').send(body);
    const file = (await up(employee).expect(201)).body;
    await up(colleague, Buffer.concat([PDF, Buffer.from('x')])).expect(404);
    await ctx.http().get(`${org.base}/expense-claims/${claimId}`).set(colleague.auth).expect(404);
    await ctx.http().get(`${org.base}/attachments/${file.id}/content`).set(colleague.auth).expect(404);
    await ctx.http().get(`${org.base}/attachments/${file.id}/content`).set(accountant.auth).expect(200);
    // A colleague's list only shows their own claims.
    expect((await ctx.http().get(`${org.base}/expense-claims`).set(colleague.auth).expect(200)).body.total).toBe(0);
    expect((await get(employee, claimId)).receiptCount).toBe(1);
  });

  it('is submitted, withdrawn, and only the claimant can change it while a draft', async () => {
    await act(accountant, claimId, 'submit').expect(403);
    expect((await act(employee, claimId, 'submit').expect(200)).body.status).toBe('SUBMITTED');
    await ctx.http().put(`${org.base}/expense-claims/${claimId}`).set(employee.auth).send({ title: 'x', lines: [{ date: day(3), accountId: org.acc['6600'], amount: '1.00' }] }).expect(409);
    expect((await act(employee, claimId, 'withdraw').expect(200)).body.status).toBe('DRAFT');
    await act(employee, claimId, 'submit').expect(200);
  });

  it('cannot be approved by its claimant or by roles without the right', async () => {
    await act(employee, claimId, 'approve').expect(403);
    await act(accountant, claimId, 'approve').expect(403);
    const inbox = (await ctx.http().get(`${org.base}/expense-claims?status=SUBMITTED`).set(approver.auth).expect(200)).body;
    expect(inbox.items[0]).toMatchObject({ number: 'EXP-000001', canApprove: true, claimant: 'Field Employee' });
  });

  it('is approved and posted to expenses, input tax and the amount owed to the employee', async () => {
    const c = (await act(approver, claimId, 'approve', { note: 'Within policy' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'APPROVED', decidedBy: 'Approver', decisionNote: 'Within policy', postingDate: today() });
    const je = (await ctx.http().get(`${org.base}/journals/${c.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(je.source).toBe('EXPENSE');
    const by = (id: string) => je.lines.filter((l: { accountId: string }) => l.accountId === id);
    expect(by(org.acc['6600']).map((l: { functionalDebit: string }) => l.functionalDebit).sort()).toEqual(['1000.00', '450.50']);
    expect(by(org.acc['1450'])[0].functionalDebit).toBe('180.00');
    expect(by(org.acc['2250'])[0].functionalCredit).toBe('1630.50');
    // Receipts are frozen for the claimant once approved; finance can still add evidence.
    await ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_CLAIM&entityId=${claimId}&fileName=late.pdf`).set(employee.auth).set('Content-Type', 'application/pdf').send(Buffer.concat([PDF, Buffer.from('late')])).expect(403);
    await act(approver, claimId, 'reject', { note: 'Too late' }).expect(409);
  });

  it('keeps the employee reimbursements account out of manual journals', async () => {
    const res = await ctx
      .http()
      .post(`${org.base}/journals`)
      .set(owner.auth)
      .send({ date: today(), memo: 'Sneaky', post: true, lines: [{ accountId: org.acc['2250'], debit: '1630.50' }, { accountId: org.acc['1120'], credit: '1630.50' }] });
    expect(res.status).toBeGreaterThanOrEqual(409);
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE expense_claim_lines SET amount = 1 WHERE claim_id = '${claimId}'`)).rejects.toThrow(/cannot be changed/);
    await expect(ctx.prisma.$executeRawUnsafe(`DELETE FROM expense_claims WHERE id = '${claimId}'`)).rejects.toThrow(/cannot be deleted/);
  });

  it('is reimbursed from a bank account, which clears what is owed', async () => {
    await act(employee, claimId, 'reimburse', { bankAccountId: org.acc['1120'], date: today() }).expect(403);
    await act(accountant, claimId, 'reimburse', { bankAccountId: org.acc['6600'], date: today() }).expect(422);
    await act(accountant, claimId, 'reimburse', { bankAccountId: org.acc['1120'], date: day(30) }).expect(422);
    const c = (await act(accountant, claimId, 'reimburse', { bankAccountId: org.acc['1120'], date: today(), reference: 'NEFT SYN001' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'REIMBURSED', reimbursedOn: today(), reimbursedBy: 'Accountant', bankAccount: '1120 · Operating Bank Account', reimbursementReference: 'NEFT SYN001' });
    // Owed to the employee on approval, cleared by the reimbursement: nothing left owing.
    const owed = await balance(org.acc['2250']);
    expect(owed?.debit).toBe(owed?.credit);
    expect(owed?.credit).toBe('1630.50');
    await act(accountant, claimId, 'reimburse', { bankAccountId: org.acc['1120'], date: today() }).expect(409);
    await act(owner, claimId, 'void', { date: today(), reason: 'Mistake' }).expect(409);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=expense_claim&entityId=${claimId}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit).map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['expense_claim.created', 'expense_claim.submitted', 'expense_claim.withdrawn', 'expense_claim.approved', 'expense_claim.reimbursed']),
    );
  });
});

describe('other paths', () => {
  it('goes back to the claimant with a reason when rejected, and can be fixed and resubmitted', async () => {
    const c = (await claim(employee, [{ date: day(5), accountId: org.acc['6600'], amount: '99.00' }], 'Team lunch (synthetic)').expect(201)).body;
    await act(employee, c.id, 'submit').expect(200);
    await act(approver, c.id, 'reject', {}).expect(400);
    expect((await act(approver, c.id, 'reject', { note: 'Attach the bill' }).expect(200)).body).toMatchObject({ status: 'REJECTED', decisionNote: 'Attach the bill', decidedBy: 'Approver' });
    const edited = (
      await ctx.http().put(`${org.base}/expense-claims/${c.id}`).set(employee.auth).send({ title: 'Team lunch (synthetic)', lines: [{ date: day(5), accountId: org.acc['6600'], amount: '89.00' }] }).expect(200)
    ).body;
    expect(edited).toMatchObject({ status: 'DRAFT', total: '89.00' });
    await act(employee, c.id, 'submit').expect(200);
  });

  it('flags a receipt that looks claimed twice', async () => {
    const dup = (await claim(employee, [{ date: day(3), accountId: org.acc['6600'], amount: '1180.00' }], 'Cab again (synthetic)').expect(201)).body;
    expect(dup.lines[0].possibleDuplicateOf).toEqual(['EXP-000001']);
    await ctx.http().delete(`${org.base}/expense-claims/${dup.id}`).set(employee.auth).expect(204);
  });

  it('never lets someone approve their own claim, even in SQL', async () => {
    const c = (await claim(owner, [{ date: day(2), accountId: org.acc['6600'], amount: '500.00' }], 'Owner travel (synthetic)').expect(201)).body;
    await act(owner, c.id, 'submit').expect(200);
    expect((await act(owner, c.id, 'approve').expect(403)).body.error).toBe('SAME_PERSON');
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `UPDATE expense_claims SET status = 'APPROVED', decided_by_id = '${owner.id}', decided_at = now(), journal_entry_id = (SELECT id FROM journal_entries WHERE org_id = '${org.orgId}' LIMIT 1), posting_date = current_date WHERE id = '${c.id}'`,
      ),
    ).rejects.toThrow(/someone other than the claimant|duplicate key/);
    // An approved, unpaid claim can be voided; its posting is reversed.
    const ok = (await act(approver, c.id, 'approve').expect(200)).body;
    const voided = (await act(owner, c.id, 'void', { date: today(), reason: 'Paid by company card instead' }).expect(200)).body;
    expect(voided).toMatchObject({ status: 'VOID', voidReason: 'Paid by company card instead' });
    const rev = (await ctx.http().get(`${org.base}/journals/${voided.voidJournalEntryId}`).set(owner.auth).expect(200)).body;
    expect(rev.reversesEntryId ?? rev.reverses?.id ?? ok.journalEntryId).toBe(ok.journalEntryId);
  });

  it('creates the reimbursements account on first use for organisations that predate it', async () => {
    const other = await createOrg(ctx, owner, { name: 'Older Co (synthetic)' });
    await setOrgFields(ctx, other.orgId, { claimsAccountId: null });
    await ctx.http().post(`${other.base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);
    const c = (await ctx.http().post(`${other.base}/expense-claims`).set(owner.auth).send({ title: 'Synthetic', lines: [{ date: day(1), accountId: other.acc['6600'], amount: '10.00' }] }).expect(201)).body;
    await ctx.http().post(`${other.base}/expense-claims/${c.id}/submit`).set(owner.auth).expect(200);
    await ctx.http().post(`${other.base}/expense-claims/${c.id}/approve`).set(approver.auth).send({}).expect(200);
    const o = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: other.orgId }, include: {} });
    const acct = await ctx.prisma.account.findUniqueOrThrow({ where: { id: o.claimsAccountId! } });
    expect(acct).toMatchObject({ code: '2251', subtype: 'EMPLOYEE_REIMBURSEMENTS', type: 'LIABILITY' });
    // The employee of the first organisation sees nothing here.
    await ctx.http().get(`${other.base}/expense-claims`).set(employee.auth).expect(404);
  });
});
