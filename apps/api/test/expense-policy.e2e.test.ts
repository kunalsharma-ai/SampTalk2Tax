import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Expense policy (EXP-013 spending limits, EXP-015 enforcement, EXP-022 violation detection). */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let approver: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let monthly: string;

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const rules = () => ctx.http().post(`${org.base}/expense-policy-rules`);
const claim = (lines: object[]) => ctx.http().post(`${org.base}/expense-claims`).set(employee.auth).send({ title: 'Policy check (synthetic)', lines }).expect(201);
const receipt = (claimId: string) =>
  ctx.http().post(`${org.base}/attachments?entityType=EXPENSE_CLAIM&entityId=${claimId}&fileName=receipt.pdf`).set(employee.auth).set('Content-Type', 'application/pdf').send(PDF).expect(201);
const submit = (claimId: string) => ctx.http().post(`${org.base}/expense-claims/${claimId}/submit`).set(employee.auth).send({});

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  employee = await registerUser(ctx, 'Policy Employee');
  approver = await registerUser(ctx, 'Approver');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[employee, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('rules', () => {
  it('are set by finance, checked for their kind, and shown to claimants', async () => {
    await rules().set(employee.auth).send({ kind: 'LINE_MAX', severity: 'WARN', amount: '2000' }).expect(403);
    const bad = await rules().set(owner.auth).send({ kind: 'CLAIM_MAX', severity: 'WARN', accountId: org.acc['6700'], amount: '10.005' }).expect(422);
    expect(bad.body.details.issues).toEqual(['Only limits per receipt, per day and per month can be narrowed to one category', 'The amount has more decimal places than INR allows']);
    expect((await rules().set(owner.auth).send({ kind: 'LINE_MAX', severity: 'WARN', accountId: org.acc['1120'], amount: '2000' }).expect(422)).body.details.issues).toEqual(['Choose an expense category employees claim to']);
    await rules().set(owner.auth).send({ kind: 'MAX_AGE_DAYS', severity: 'WARN', amount: '5' }).expect(422);

    const line = (await rules().set(owner.auth).send({ kind: 'LINE_MAX', severity: 'WARN', accountId: org.acc['6700'], amount: '2000' }).expect(201)).body;
    expect(line).toMatchObject({ kind: 'LINE_MAX', severity: 'WARN', accountLabel: '6700 · Travel', amount: '2000', isActive: true, summary: 'At most INR 2000.00 per receipt for 6700 · Travel' });
    monthly = (await rules().set(owner.auth).send({ kind: 'MONTHLY_MAX', severity: 'BLOCK', amount: '10000' }).expect(201)).body.id;
    await rules().set(owner.auth).send({ kind: 'RECEIPT_ABOVE', severity: 'BLOCK', amount: '500' }).expect(201);

    const opts = (await ctx.http().get(`${org.base}/expense-claims/options`).set(employee.auth).expect(200)).body;
    expect(opts.policy.map((r: { summary: string }) => r.summary)).toEqual(['At most INR 2000.00 per receipt for 6700 · Travel', 'At most INR 10000.00 a calendar month', 'Receipts attached for any receipt line over INR 500.00']);
    await ctx.http().get(`${org.base}/expense-policy-rules`).set(employee.auth).expect(403);
  });
});

describe('a claim outside the policy', () => {
  let first: string;

  it('is shown what it breaks, and cannot be submitted past a blocking rule', async () => {
    const c = (await claim([{ date: day(1), accountId: org.acc['6700'], merchant: 'Synthetic Air', amount: '2500.00' }])).body;
    first = c.id;
    expect(c.policy.map((v: { severity: string; message: string }) => [v.severity, v.message])).toEqual([
      ['WARN', 'Line 1: INR 2500.00 is over the limit of INR 2000.00 per receipt for 6700 · Travel'],
      ['BLOCK', 'Attach the receipts: line 1 is over INR 500.00 and the claim has no receipt attached'],
    ]);
    const r = await submit(first).expect(422);
    expect(r.body.error).toBe('POLICY_BLOCKED');
    expect(r.body.details.issues).toEqual(['Attach the receipts: line 1 is over INR 500.00 and the claim has no receipt attached']);

    await receipt(first);
    const s = (await submit(first).expect(200)).body;
    expect(s.policy.map((v: { kind: string }) => v.kind)).toEqual(['LINE_MAX']);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'expense_claim.submitted', entityId: first } });
    expect((audit!.data as { policyWarnings: string[] }).policyWarnings).toHaveLength(1);
  });

  it('needs the approver to say why it is approved anyway', async () => {
    const r = await ctx.http().post(`${org.base}/expense-claims/${first}/approve`).set(approver.auth).send({}).expect(422);
    expect(r.body.error).toBe('POLICY_NOTE_REQUIRED');
    const ok = (await ctx.http().post(`${org.base}/expense-claims/${first}/approve`).set(approver.auth).send({ note: 'Only flight available that day' }).expect(200)).body;
    expect(ok).toMatchObject({ status: 'APPROVED', decisionNote: 'Only flight available that day', policy: null });
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'expense_claim.approved', entityId: first } });
    expect((audit!.data as { policyExceptions: string[] }).policyExceptions).toEqual(['Line 1: INR 2500.00 is over the limit of INR 2000.00 per receipt for 6700 · Travel']);
  });

  it('counts the month across claims, so splitting a claim does not get around a limit', async () => {
    const c = (await claim([{ date: day(1), accountId: org.acc['6600'], merchant: 'Synthetic Advisers', amount: '8000.00' }])).body;
    await receipt(c.id);
    const r = await submit(c.id).expect(422);
    expect(r.body.details.issues).toEqual([`In ${day(1).slice(0, 7)}, INR 10500.00 is claimed (INR 2500.00 of it on your other claims), over the limit of INR 10000.00 a month`]);

    // Finance turns the rule off; the claim goes through.
    await ctx.http().put(`${org.base}/expense-policy-rules/${monthly}`).set(owner.auth).send({ severity: 'BLOCK', amount: '10000', isActive: false }).expect(200);
    expect((await submit(c.id).expect(200)).body.status).toBe('SUBMITTED');
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: org.orgId, action: { startsWith: 'expense_policy_rule.' } } })).toBe(4);
  });

  it('flags old receipts, but not mileage or per diem lines for missing receipts', async () => {
    await rules().set(owner.auth).send({ kind: 'MAX_AGE_DAYS', severity: 'WARN', days: 60 }).expect(201);
    const rate = (await ctx.http().post(`${org.base}/expense-allowance-rates`).set(owner.auth).send({ kind: 'MILEAGE', name: 'Car', rate: '10', accountId: org.acc['6700'] }).expect(201)).body.id;
    const c = (await claim([{ date: day(70), allowance: { rateId: rate, quantity: '100', from: 'Pune', to: 'Mumbai' } }])).body;
    expect(c.policy.map((v: { message: string }) => v.message)).toEqual(['Line 1: the receipt is 70 days old; claims must be made within 60 days']);
    expect((await submit(c.id).expect(200)).body.policy).toHaveLength(1);
  });
});
