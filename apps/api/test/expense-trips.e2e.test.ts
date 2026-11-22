import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Business trips (EXP-007) against the real API and database: requested with an estimate, approved
 * by someone else, claims linked by the traveller, the cost against the estimate with lines outside
 * the dates; unlinking, cancelling and rejecting; validation, visibility, permissions and tenants.
 */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let colleague: TestUser;
let approver: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let tripId: string;
let claimA: { id: string; number: string };
let claimB: { id: string; number: string };
let label: Record<string, string>;

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const T = (id = '') => `${org.base}/expense-trips${id ? `/${id}` : ''}`;
const ESTIMATE = { transport: '12000', lodging: '9000', meals: '3000', other: '0' };
const trip = (user: TestUser, body: Record<string, unknown> = {}) => ctx.http().post(T()).set(user.auth).send({ purpose: 'Client workshop in Pune', destination: 'Pune', startDate: day(10), endDate: day(8), estimate: ESTIMATE, ...body });
const claim = async (user: TestUser, lines: unknown[]) => (await ctx.http().post(`${org.base}/expense-claims`).set(user.auth).send({ title: 'Pune trip', lines }).expect(201)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Trip Owner');
  employee = await registerUser(ctx, 'Tara Traveller');
  colleague = await registerUser(ctx, 'Other Employee');
  approver = await registerUser(ctx, 'Trip Approver');
  outsider = await registerUser(ctx, 'Trip Outsider');
  org = await createOrg(ctx, owner, { name: 'Travelling Co Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Travel Ltd' });
  for (const [u, role] of [[employee, 'EMPLOYEE'], [colleague, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of new Set([day(12), today()].map((d) => fiscalYearForDate(d, 4)))) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  const accounts = (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { id: string; code: string; name: string }[];
  label = Object.fromEntries(accounts.map((a) => [a.code, `${a.code} ${a.name}`]));
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('business trips', () => {
  it('is requested by the traveller and decided by someone else', async () => {
    const t = (await trip(employee).expect(201)).body;
    tripId = t.id;
    expect(t).toMatchObject({ reference: 'TRIP-0001', traveller: 'Tara Traveller', status: 'REQUESTED', destination: 'Pune', canDecide: false, canCancel: true, claims: [], linkable: [] });
    expect(t.costs).toMatchObject({ days: 3, spent: '0.00', estimate: { total: '24000.00' } });
    await ctx.http().post(`${T(tripId)}/approve`).set(employee.auth).send({}).expect(403);
    const own = (await trip(approver).expect(201)).body;
    expect((await ctx.http().post(`${T(own.id)}/approve`).set(approver.auth).send({}).expect(403)).body.error).toBe('SAME_PERSON');
    expect((await ctx.http().post(`${T(own.id)}/reject`).set(owner.auth).send({}).expect(422)).body.message).toBe('Say why the trip is rejected');
    expect((await ctx.http().post(`${T(own.id)}/reject`).set(owner.auth).send({ note: 'Use a video call' }).expect(200)).body).toMatchObject({ status: 'REJECTED', decidedBy: 'Trip Owner', decisionNote: 'Use a video call' });

    const c = (await claim(employee, [{ date: day(9), accountId: org.acc['6600'], amount: '500.00' }]));
    expect((await ctx.http().post(`${T(tripId)}/claims`).set(employee.auth).send({ claimId: c.id }).expect(409)).body.error).toBe('NOT_APPROVED');
    expect((await ctx.http().get(T(tripId)).set(approver.auth).expect(200)).body.canDecide).toBe(true);
    const ok = (await ctx.http().post(`${T(tripId)}/approve`).set(approver.auth).send({ note: 'Within budget' }).expect(200)).body;
    expect(ok).toMatchObject({ status: 'APPROVED', decidedBy: 'Trip Approver', decisionNote: 'Within budget', canDecide: false });
    expect((await ctx.http().post(`${T(tripId)}/approve`).set(approver.auth).send({}).expect(409)).body.error).toBe('NOT_REQUESTED');
    // The traveller now sees the claims they can link.
    expect((await ctx.http().get(T(tripId)).set(employee.auth).expect(200)).body.linkable.map((x: { id: string }) => x.id)).toEqual([c.id]);
  });

  it('links the traveller\'s claims and shows the cost against the estimate', async () => {
    claimA = await claim(employee, [
      { date: day(10), accountId: org.acc['6600'], merchant: 'Synthetic Airlines', amount: '13000.00' },
      { date: day(9), accountId: org.acc['6200'], merchant: 'Synthetic Hotel', amount: '6000.00' },
    ]);
    await ctx.http().post(`${org.base}/expense-claims/${claimA.id}/submit`).set(employee.auth).send({}).expect(200);
    await ctx.http().post(`${org.base}/expense-claims/${claimA.id}/approve`).set(approver.auth).send({}).expect(200);
    claimB = await claim(employee, [
      { date: day(8), accountId: org.acc['6200'], amount: '3000.00' },
      { date: day(2), accountId: org.acc['6600'], amount: '7000.00' },
    ]);
    const theirs = await claim(colleague, [{ date: day(9), accountId: org.acc['6600'], amount: '100.00' }]);
    await ctx.http().post(`${T(tripId)}/claims`).set(employee.auth).send({ claimId: theirs.id }).expect(404);
    await ctx.http().post(`${T(tripId)}/claims`).set(colleague.auth).send({ claimId: theirs.id }).expect(404);
    await ctx.http().post(`${T(tripId)}/claims`).set(employee.auth).send({ claimId: claimA.id }).expect(200);
    const t = (await ctx.http().post(`${T(tripId)}/claims`).set(employee.auth).send({ claimId: claimB.id }).expect(200)).body;
    expect(t.claims.map((c: { number: string; status: string; canUnlink: boolean }) => [c.number, c.status, c.canUnlink])).toEqual([[claimA.number, 'APPROVED', false], [claimB.number, 'DRAFT', true]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(t.costs).toMatchObject({ spent: '19000.00', pending: '10000.00', remaining: '-5000.00', perDay: '6333.33' });
    expect(t.costs.byCategory).toEqual([
      { account: label['6600'], spent: '13000.00', pending: '7000.00' },
      { account: label['6200'], spent: '6000.00', pending: '3000.00' },
    ]);
    expect(t.costs.flags).toEqual([
      { code: 'OVER_ESTIMATE', message: 'Claims come to 5000.00 (20.8%) more than the estimate' },
      { code: 'OUTSIDE_DATES', message: '1 line is dated outside the trip' },
    ]);
    expect(t.costs.outsideDates).toEqual([{ claimId: claimB.id, number: claimB.number, lineNo: 2, date: day(2), amount: '7000.00' }]);
    expect(t.canCancel).toBe(false);

    const second = (await trip(employee, { purpose: 'Follow-up visit', startDate: day(5), endDate: day(4) }).expect(201)).body;
    await ctx.http().post(`${T(second.id)}/approve`).set(owner.auth).send({}).expect(200);
    expect((await ctx.http().post(`${T(second.id)}/claims`).set(employee.auth).send({ claimId: claimB.id }).expect(409)).body.error).toBe('ALREADY_LINKED');
    expect((await ctx.http().post(`${T(second.id)}/cancel`).set(employee.auth).expect(200)).body.status).toBe('CANCELLED');
  });

  it('unlinks claims not yet approved and refuses to cancel a trip with claims', async () => {
    expect((await ctx.http().delete(`${T(tripId)}/claims/${claimA.id}`).set(employee.auth).expect(409)).body.error).toBe('CLAIM_POSTED');
    await ctx.http().delete(`${T(tripId)}/claims/${claimB.id}`).set(approver.auth).expect(403);
    const t = (await ctx.http().delete(`${T(tripId)}/claims/${claimB.id}`).set(employee.auth).expect(200)).body;
    expect(t.costs).toMatchObject({ spent: '19000.00', pending: '0.00', flags: [] });
    expect(t.claims).toHaveLength(1);
    expect((await ctx.http().post(`${T(tripId)}/cancel`).set(employee.auth).expect(409)).body.error).toBe('HAS_CLAIMS');
    await ctx.http().post(`${T(tripId)}/cancel`).set(approver.auth).expect(403);
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, entityType: 'expense_trip', entityId: tripId }).toArray();
    expect(events.map((e) => e.action)).toEqual(['expense_trip.requested', 'expense_trip.approved', 'expense_trip.claim_linked', 'expense_trip.claim_linked', 'expense_trip.claim_unlinked']);
  });

  it('shows travellers their own trips and finance everyone\'s', async () => {
    const mine = (await ctx.http().get(T()).set(employee.auth).expect(200)).body;
    expect(mine.map((t: { reference: string; status: string }) => [t.reference, t.status])).toEqual([['TRIP-0003', 'CANCELLED'], ['TRIP-0001', 'APPROVED']]);
    expect(mine[1]).toMatchObject({ estimate: '24000.00', claims: 1, traveller: 'Tara Traveller' });
    expect((await ctx.http().get(T()).set(colleague.auth).expect(200)).body).toEqual([]);
    await ctx.http().get(T(tripId)).set(colleague.auth).expect(404);
    expect((await ctx.http().get(T()).set(owner.auth).expect(200)).body).toHaveLength(3);
    expect((await ctx.http().get(`${T()}?status=REJECTED`).set(approver.auth).expect(200)).body.map((t: { reference: string }) => t.reference)).toEqual(['TRIP-0002']);
    expect((await ctx.http().get(`${T()}?mine=true`).set(approver.auth).expect(200)).body).toHaveLength(1);
  });

  it('checks the request', async () => {
    expect((await trip(employee, { startDate: day(3), endDate: day(5) }).expect(422)).body.message).toBe('The trip ends before it starts');
    expect((await trip(employee, { startDate: day(0), endDate: day(-95) }).expect(422)).body.message).toMatch(/at most 90 days/);
    expect((await trip(employee, { startDate: day(200), endDate: day(199) }).expect(422)).body.message).toMatch(/too old/);
    await trip(employee, { estimate: { ...ESTIMATE, meals: '-5' } }).expect(400);
    await trip(employee, { purpose: '' }).expect(400);
    await trip(employee, { extra: true }).expect(400);
  });

  it('keeps each organisation to itself', async () => {
    await ctx.http().get(T(tripId)).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/expense-trips`).set(outsider.auth).expect(200)).body).toEqual([]);
    await ctx.http().get(`${other.base}/expense-trips/${tripId}`).set(outsider.auth).expect(404);
  });
});
