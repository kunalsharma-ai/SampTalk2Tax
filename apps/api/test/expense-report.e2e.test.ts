import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Expense reports (EXP-017) against the real API and database: claim lines by category, month,
 * person, status and merchant over a period, drafts and rejected claims left out, filters, and
 * claimants seeing only their own spending.
 */
let ctx: Ctx;
let owner: TestUser;
let asha: TestUser;
let ravi: TestUser;
let approver: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let R: string;

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const FROM = day(60);
const TO = today();

async function claim(user: TestUser, title: string, lines: Record<string, unknown>[], then: 'draft' | 'submit' | 'approve' | 'reject') {
  const c = (await ctx.http().post(`${org.base}/expense-claims`).set(user.auth).send({ title, lines }).expect(201)).body;
  if (then === 'draft') return c;
  await ctx.http().post(`${org.base}/expense-claims/${c.id}/submit`).set(user.auth).expect(200);
  if (then === 'approve') await ctx.http().post(`${org.base}/expense-claims/${c.id}/approve`).set(approver.auth).send({}).expect(200);
  if (then === 'reject') await ctx.http().post(`${org.base}/expense-claims/${c.id}/reject`).set(approver.auth).send({ note: 'Not ours' }).expect(200);
  return c;
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Report Owner');
  asha = await registerUser(ctx, 'Asha Rao');
  ravi = await registerUser(ctx, 'Ravi Menon');
  approver = await registerUser(ctx, 'Report Approver');
  viewer = await registerUser(ctx, 'Report Viewer');
  org = await createOrg(ctx, owner, { name: 'Expense Report Ltd' });
  R = `${org.base}/reports/expenses`;
  for (const [u, role] of [[asha, 'EMPLOYEE'], [ravi, 'EMPLOYEE'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await claim(asha, 'Client visit (synthetic)', [
    { date: day(3), accountId: org.acc['6400'], merchant: 'Uber', description: 'Cab', amount: '400.00' },
    { date: day(3), accountId: org.acc['6600'], merchant: ' uber ', description: 'Advice', amount: '1000.00' },
  ], 'approve');
  await claim(ravi, 'Conference (synthetic)', [{ date: day(40), accountId: org.acc['6400'], merchant: 'IndiGo', amount: '5250.00' }], 'submit');
  await claim(ravi, 'Old trip (synthetic)', [{ date: day(90), accountId: org.acc['6400'], merchant: 'IndiGo', amount: '999.00' }], 'approve');
  await claim(asha, 'Draft (synthetic)', [{ date: day(2), accountId: org.acc['6400'], amount: '77.00' }], 'draft');
  await claim(ravi, 'Rejected (synthetic)', [{ date: day(2), accountId: org.acc['6400'], amount: '66.00' }], 'reject');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('expense reports', () => {
  it('sums claimed spending in the period by category, month, person, status and merchant', async () => {
    const r = (await ctx.http().get(R).query({ from: FROM, to: TO }).set(owner.auth).expect(200)).body;
    expect(r).toMatchObject({ scope: 'all', currency: 'INR', statuses: ['SUBMITTED', 'APPROVED', 'REIMBURSED'], totals: { claims: 2, lines: 3, total: '6650.00' } });
    expect(r.byCategory.map((g: { code: string; total: string; share: string }) => [g.code, g.total, g.share])).toEqual([['6400', '5650.00', '85.0'], ['6600', '1000.00', '15.0']]);
    expect(r.byPerson.map((g: { name: string; total: string; claims: number }) => [g.name, g.total, g.claims])).toEqual([['Ravi Menon', '5250.00', 1], ['Asha Rao', '1400.00', 1]]);
    expect(r.byStatus.map((g: { status: string; total: string }) => [g.status, g.total])).toEqual([['SUBMITTED', '5250.00'], ['APPROVED', '1400.00']]);
    expect(r.byMerchant.map((g: { merchant: string; total: string }) => [g.merchant, g.total])).toEqual([['IndiGo', '5250.00'], ['Uber', '1400.00']]);
    expect(r.byMonth.reduce((s: number, g: { total: string }) => s + Number(g.total), 0)).toBe(6650);
  });

  it('filters by status, person and category', async () => {
    const approved = (await ctx.http().get(R).query({ from: FROM, to: TO, status: 'APPROVED,REIMBURSED' }).set(owner.auth).expect(200)).body;
    expect(approved.totals.total).toBe('1400.00');
    const raviId = (await ctx.http().get(R).query({ from: FROM, to: TO }).set(owner.auth)).body.byPerson[0].claimantId;
    expect((await ctx.http().get(R).query({ from: FROM, to: TO, claimantId: raviId }).set(owner.auth).expect(200)).body.totals.total).toBe('5250.00');
    expect((await ctx.http().get(R).query({ from: FROM, to: TO, accountId: org.acc['6600'] }).set(owner.auth).expect(200)).body.totals).toMatchObject({ claims: 1, lines: 1, total: '1000.00' });
    expect((await ctx.http().get(R).query({ from: FROM, to: TO, status: 'DRAFT' }).set(owner.auth).expect(400)).body.error).toBeDefined();
    expect((await ctx.http().get(R).query({ from: TO, to: FROM }).set(owner.auth).expect(422)).body.error).toBe('BAD_RANGE');
  });

  it('shows claimants only their own spending, whatever they ask for', async () => {
    const mine = (await ctx.http().get(R).query({ from: FROM, to: TO }).set(asha.auth).expect(200)).body;
    expect(mine).toMatchObject({ scope: 'mine', totals: { total: '1400.00' } });
    expect(mine.byPerson.map((g: { name: string }) => g.name)).toEqual(['Asha Rao']);
    const raviId = (await ctx.http().get(R).query({ from: FROM, to: TO }).set(owner.auth)).body.byPerson[0].claimantId;
    expect((await ctx.http().get(R).query({ from: FROM, to: TO, claimantId: raviId }).set(asha.auth).expect(200)).body.totals.total).toBe('1400.00');
    expect((await ctx.http().get(R).query({ from: FROM, to: TO }).set(viewer.auth).expect(200)).body.scope).toBe('all');
    const other = await registerUser(ctx, 'Report Outsider');
    await ctx.http().get(R).query({ from: FROM, to: TO }).set(other.auth).expect(404);
  });
});
