import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Reimbursement routing (EXP-026) against the real API and database: Asha has a salary account on
 * her employee record and is routed to a bank transfer, Ravi's employee record has no bank details
 * and Meena has none at all, so both are paid in cash; a buffer that leaves no room makes them
 * wait; paying the ready people reimburses every claim through the usual journal; account numbers
 * are never shown; permissions, validation and tenant isolation.
 */
const T = today();
const APR = `${Number(T.slice(0, 4)) - (T.slice(5, 7) < '04' ? 1 : 0)}-04`;
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let viewer: TestUser;
let asha: TestUser;
let ravi: TestUser;
let meena: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const claims: Record<string, { id: string; number: string }> = {};

const R = () => `${org.base}/expense-routing`;
async function approved(key: string, who: TestUser, amount: string, ago: number) {
  const x = (await ctx.http().post(`${org.base}/expense-claims`).set(who.auth).send({ title: `Trip ${key}`, lines: [{ date: addDays(T, -ago - 1), accountId: org.acc['6600'], merchant: 'Synthetic Travels', amount }] }).expect(201)).body;
  await ctx.http().post(`${org.base}/expense-claims/${x.id}/submit`).set(who.auth).send({}).expect(200);
  claims[key] = (await ctx.http().post(`${org.base}/expense-claims/${x.id}/approve`).set(approver.auth).send({ date: addDays(T, -ago) }).expect(200)).body;
}
const fund = async (accountCode: string, amount: string, customer: string) =>
  ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: customer, date: addDays(T, -20), bankAccountId: org.acc[accountCode], amount, allocations: [] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Route Owner');
  approver = await registerUser(ctx, 'Route Approver');
  viewer = await registerUser(ctx, 'Route Viewer');
  asha = await registerUser(ctx, 'Asha Sales');
  ravi = await registerUser(ctx, 'Ravi Field');
  meena = await registerUser(ctx, 'Meena Design');
  outsider = await registerUser(ctx, 'Route Outsider');
  org = await createOrg(ctx, owner, { name: 'Routed Claims Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Routing Ltd' });
  for (const [u, role] of [[approver, 'APPROVER'], [viewer, 'VIEWER'], [asha, 'EMPLOYEE'], [ravi, 'EMPLOYEE'], [meena, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const structure = { effectiveFrom: `${APR}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '30000' }] };
  // Asha's employee record has her salary account (email in another case); Ravi's has none; Meena has no employee record.
  await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'E001', name: 'Asha S', email: asha.email.toUpperCase(), dateOfJoining: `${APR}-01`, structure, bankAccountName: 'Asha S', bankAccountNumber: '5010 0012 3456 78', bankIfsc: 'HDFC0001234' }).expect(201);
  await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'E002', name: 'Ravi F', email: ravi.email, dateOfJoining: `${APR}-01`, structure }).expect(201);
  const customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Funding Customer', isCustomer: true }).expect(201)).body.id;
  await fund('1120', '20000', customer);
  await fund('1110', '1000', customer);
  await approved('a1', asha, '3000.00', 10);
  await approved('a2', asha, '2000.00', 2);
  await approved('r1', ravi, '500.00', 3);
  await approved('m1', meena, '400.00', 1);
});
afterAll(async () => {
  await ctx?.app.close();
});

type Group = { claimantId: string; claimant: string; route: string; routeLabel: string; account: { code: string } | null; total: string; daysWaiting: number; overdue: boolean; reason: string; employee: { name: string } | null; claims: { number: string }[] };

describe('reimbursement routing', () => {
  it('routes each person to a bank transfer or cash from an account with room', async () => {
    const r = (await ctx.http().get(R()).set(owner.auth).expect(200)).body;
    expect(r).toMatchObject({ asOf: T, currency: 'INR', buffer: '0', totals: { claims: 4, people: 3, total: '5900.00', ready: '5900.00', waiting: '0.00', overdue: 1 } });
    expect((r.groups as Group[]).map((g) => [g.claimant, g.routeLabel, g.account?.code ?? null, g.total, g.daysWaiting, g.overdue])).toEqual([
      ['Asha Sales', 'Bank transfer', '1120', '5000.00', 10, true],
      ['Ravi Field', 'Pay in cash', '1110', '500.00', 3, false],
      ['Meena Design', 'Pay in cash', '1110', '400.00', 1, false],
    ]);
    expect(r.groups[0].claims.map((c: { number: string }) => c.number)).toEqual([claims.a1!.number, claims.a2!.number]);
    expect(r.groups[0].employee).toMatchObject({ name: 'Asha S' });
    expect(r.groups[0].reason).toBe("Asha S's salary account is on the employee record. Pay from Operating Bank Account, the account with the most room.");
    expect(r.groups[2].employee).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/5010|0012|3456/);
  });

  it('makes people wait when the buffer leaves no room', async () => {
    const r = (await ctx.http().get(`${R()}?buffer=18000`).set(owner.auth).expect(200)).body;
    expect((r.groups as Group[]).map((g) => [g.claimant, g.route])).toEqual([
      ['Asha Sales', 'WAIT_FOR_CASH'],
      ['Ravi Field', 'WAIT_FOR_CASH'],
      ['Meena Design', 'WAIT_FOR_CASH'],
    ]);
    expect(r.totals).toMatchObject({ ready: '0.00', waiting: '5900.00' });
    const no = await ctx.http().post(`${R()}/pay`).set(owner.auth).send({ claimantIds: [asha.id], buffer: '18000' }).expect(409);
    expect(no.body.error).toBe('NOTHING_READY');
  });

  it('pays the chosen ready people and reimburses every claim', async () => {
    const r = (await ctx.http().post(`${R()}/pay`).set(owner.auth).send({ claimantIds: [asha.id, meena.id], buffer: '0', reference: 'Friday run' }).expect(200)).body;
    expect(r.paid.map((p: { claimant: string; total: string; account: { code: string } }) => [p.claimant, p.total, p.account.code])).toEqual([['Asha Sales', '5000.00', '1120'], ['Meena Design', '400.00', '1110']]);
    expect(r.skipped).toEqual([]);
    for (const k of ['a1', 'a2', 'm1']) {
      const c = (await ctx.http().get(`${org.base}/expense-claims/${claims[k]!.id}`).set(owner.auth).expect(200)).body;
      expect(c).toMatchObject({ status: 'REIMBURSED', reimbursedOn: T, reimbursementReference: 'Friday run' });
    }
    const after = (await ctx.http().get(R()).set(owner.auth).expect(200)).body;
    expect((after.groups as Group[]).map((g) => g.claimant)).toEqual(['Ravi Field']);
    expect(after.accounts.find((a: { code: string }) => a.code === '1120')).toMatchObject({ balance: '15000.00' });
  });

  it('checks permissions, validation and tenants', async () => {
    await ctx.http().get(R()).set(viewer.auth).expect(403);
    await ctx.http().get(R()).set(asha.auth).expect(403);
    await ctx.http().post(`${R()}/pay`).set(approver.auth).send({ claimantIds: [ravi.id], buffer: '0' }).expect(403);
    await ctx.http().get(`${R()}?buffer=-5`).set(owner.auth).expect(400);
    await ctx.http().post(`${R()}/pay`).set(owner.auth).send({ claimantIds: [], buffer: '0' }).expect(400);
    await ctx.http().get(R()).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/expense-routing`).set(outsider.auth).expect(200)).body;
    expect(theirs.groups).toEqual([]);
    await ctx.http().post(`${other.base}/expense-routing/pay`).set(outsider.auth).send({ claimantIds: [ravi.id], buffer: '0' }).expect(409);
  });
});
