import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Leave (PAY-011): leave types, balances for the April-March year, and unpaid leave carried
 * to the month's payslip as loss of pay. A posted month is closed for leave.
 */
const t = today();
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const YEAR = `${FY}-${String((FY + 1) % 100).padStart(2, '0')}`;
const [APR, MAY] = [`${FY}-04`, `${FY}-05`];

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let emp: string;
let other: string;
const types: Record<string, string> = {};
const leave = (body: Record<string, unknown>, who = owner) => ctx.http().post(`${org.base}/payroll/leave`).set(who.auth).send({ employeeId: emp, ...body });
const balances = async (employeeId = emp) => (await ctx.http().get(`${org.base}/payroll/leave/balances?year=${YEAR}&employeeId=${employeeId}`).set(owner.auth).expect(200)).body as { code: string; allowance: string | null; taken: string; left: string | null }[];
const slip = async (runId: string, code = 'L001') => (await ctx.http().get(`${org.base}/payroll/runs/${runId}`).set(owner.auth).expect(200)).body.payslips.find((s: { employee: { code: string } }) => s.employee.code === code);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Leave Owner');
  viewer = await registerUser(ctx, 'Leave Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().put(`${org.base}/payroll/settings`).set(owner.auth).send({}).expect(200);
  const structure = { effectiveFrom: `${APR}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '30000' }] };
  emp = (await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'L001', name: 'Anil Gupta', dateOfJoining: `${APR}-01`, structure }).expect(201)).body.id;
  other = (await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'L002', name: 'Farah Khan', dateOfJoining: `${APR}-01`, structure }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('leave types', () => {
  it('creates paid and unpaid types and checks them', async () => {
    const add = async (body: Record<string, unknown>) => (types[body.code as string] = (await ctx.http().post(`${org.base}/payroll/leave-types`).set(owner.auth).send(body).expect(201)).body.id);
    await add({ code: 'EL', name: 'Earned leave', paid: true, annualDays: '18' });
    await add({ code: 'SL', name: 'Sick leave', paid: true, annualDays: '7.5' });
    await add({ code: 'LWP', name: 'Leave without pay', paid: false, annualDays: '0' });
    expect((await ctx.http().post(`${org.base}/payroll/leave-types`).set(owner.auth).send({ code: 'el', name: 'Again', paid: true, annualDays: '1' }).expect(409)).body.error).toBe('DUPLICATE_LEAVE_TYPE');
    expect((await ctx.http().post(`${org.base}/payroll/leave-types`).set(owner.auth).send({ code: 'X', name: 'Unpaid with days', paid: false, annualDays: '5' }).expect(422)).body.error).toBe('INVALID_LEAVE_TYPE');
    await ctx.http().post(`${org.base}/payroll/leave-types`).set(owner.auth).send({ code: 'Y', name: 'Quarter', paid: true, annualDays: '1.25' }).expect(400);
    await ctx.http().post(`${org.base}/payroll/leave-types`).set(viewer.auth).send({ code: 'V', name: 'Viewer', paid: true, annualDays: '1' }).expect(403);
    const list = (await ctx.http().get(`${org.base}/payroll/leave-types`).set(owner.auth).expect(200)).body;
    expect(list.map((x: { code: string; annualDays: string }) => `${x.code}:${x.annualDays}`)).toEqual(['EL:18', 'LWP:0', 'SL:7.5']);
  });
});

describe('recording leave', () => {
  it('takes paid leave from the balance and refuses more than is left', async () => {
    await leave({ leaveTypeId: types.EL, from: `${APR}-07`, to: `${APR}-10`, days: '4', reason: 'Family wedding' }).expect(201);
    await leave({ leaveTypeId: types.SL, from: `${APR}-14`, to: `${APR}-14`, days: '0.5' }).expect(201);
    const b = await balances();
    expect(b.map((x) => `${x.code}:${x.allowance}:${x.taken}:${x.left}`)).toEqual(['EL:18:4:14', 'LWP:null:0:null', 'SL:7.5:0.5:7']);
    const short = await leave({ leaveTypeId: types.SL, from: `${MAY}-04`, to: `${MAY}-11`, days: '8' }).expect(409);
    expect(short.body).toMatchObject({ error: 'NOT_ENOUGH_LEAVE', message: expect.stringContaining('Only 7 days of Sick leave are left') });
    // The other employee's balance is untouched.
    expect((await balances(other)).find((x) => x.code === 'EL')).toMatchObject({ taken: '0', left: '18' });
  });

  it('checks the dates and days', async () => {
    const err = async (body: Record<string, unknown>) => (await leave({ leaveTypeId: types.EL, ...body }).expect((r) => expect([409, 422]).toContain(r.status))).body.error;
    expect(await err({ from: `${APR}-28`, to: `${MAY}-02`, days: '5' })).toBe('INVALID_LEAVE');
    expect(await err({ from: `${APR}-20`, to: `${APR}-21`, days: '3' })).toBe('INVALID_LEAVE');
    expect(await err({ from: `${APR}-22`, to: `${APR}-21`, days: '1' })).toBe('INVALID_LEAVE');
    expect(await err({ from: `${APR}-09`, to: `${APR}-11`, days: '1' })).toBe('LEAVE_OVERLAPS');
    expect(await err({ from: `${FY}-03-30`, to: `${FY}-03-31`, days: '1' })).toBe('INVALID_LEAVE');
  });

  it('carries unpaid leave to the draft payslip as loss of pay', async () => {
    const run = (await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: APR, payDate: `${APR}-30` }).expect(201)).body.id;
    expect(await slip(run)).toMatchObject({ lopDays: '0.0', leaveLopDays: '0.0', paidDays: '30.0', gross: '30000.00' });
    const r = (await leave({ leaveTypeId: types.LWP, from: `${APR}-20`, to: `${APR}-22`, days: '3' }).expect(201)).body;
    expect(r).toMatchObject({ paid: false, days: '3', draftUpdated: 'PAY-000001' });
    // 27 of 30 days paid; the payslip's own loss-of-pay days stay separate.
    expect(await slip(run)).toMatchObject({ lopDays: '0.0', leaveLopDays: '3.0', paidDays: '27.0', gross: '27000.00' });
    await ctx.http().put(`${org.base}/payroll/runs/${run}/payslips/${emp}`).set(owner.auth).send({ lopDays: '1', oneOffs: [] }).expect(200);
    expect(await slip(run)).toMatchObject({ lopDays: '1.0', leaveLopDays: '3.0', paidDays: '26.0' });
    // Loss of pay on the payslip and unpaid leave together cannot pass the days employed.
    await leave({ leaveTypeId: types.LWP, from: `${APR}-01`, to: `${APR}-06`, days: '6' }).expect(201);
    const over = await ctx.http().put(`${org.base}/payroll/runs/${run}/payslips/${emp}`).set(owner.auth).send({ lopDays: '25', oneOffs: [] }).expect(422);
    expect(over.body.message).toContain('with 9 days of unpaid leave');
    // Cancelling unpaid leave gives the days back.
    const all = (await ctx.http().get(`${org.base}/payroll/leave?year=${YEAR}&employeeId=${emp}`).set(owner.auth).expect(200)).body;
    const six = all.find((x: { days: string; paid: boolean }) => x.days === '6' && !x.paid);
    await ctx.http().post(`${org.base}/payroll/leave/${six.id}/cancel`).set(owner.auth).send({ reason: 'Came to work after all' }).expect(200);
    expect(await slip(run)).toMatchObject({ leaveLopDays: '3.0', paidDays: '26.0' });
    await ctx.http().post(`${org.base}/payroll/leave/${six.id}/cancel`).set(owner.auth).send({ reason: 'Again' }).expect(409);
    // Unpaid leave shows as taken, with no balance.
    expect((await balances()).find((x) => x.code === 'LWP')).toMatchObject({ taken: '3', left: null });
  });

  it('closes a posted month for leave', async () => {
    const runs = (await ctx.http().get(`${org.base}/payroll/runs`).set(owner.auth).expect(200)).body;
    await ctx.http().post(`${org.base}/payroll/runs/${runs[0].id}/post`).set(owner.auth).expect(200);
    expect((await leave({ leaveTypeId: types.EL, from: `${APR}-27`, to: `${APR}-27`, days: '1' }).expect(409)).body.error).toBe('MONTH_PAID');
    const all = (await ctx.http().get(`${org.base}/payroll/leave?year=${YEAR}`).set(owner.auth).expect(200)).body;
    const el = all.find((x: { leaveType: { code: string }; status: string }) => x.leaveType.code === 'EL' && x.status === 'RECORDED');
    expect((await ctx.http().post(`${org.base}/payroll/leave/${el.id}/cancel`).set(owner.auth).send({ reason: 'Mistake' }).expect(409)).body.error).toBe('MONTH_PAID');
    // Whether a type is paid cannot change once leave is recorded under it.
    expect((await ctx.http().put(`${org.base}/payroll/leave-types/${types.EL}`).set(owner.auth).send({ code: 'EL', name: 'Earned leave', paid: false, annualDays: '0' }).expect(409)).body.error).toBe('LEAVE_TYPE_IN_USE');
    // The next month is open.
    await leave({ leaveTypeId: types.EL, from: `${MAY}-05`, to: `${MAY}-06`, days: '2' }).expect(201);
    expect((await balances()).find((x) => x.code === 'EL')).toMatchObject({ taken: '6', left: '12' });
  });

  it('lets a viewer see nothing and keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/payroll/leave?year=${YEAR}`).set(viewer.auth).expect(403);
    await leave({ leaveTypeId: types.EL, from: `${MAY}-20`, to: `${MAY}-20`, days: '1' }, viewer).expect(403);
    const stranger = await registerUser(ctx, 'Leave Stranger');
    const theirs = await createOrg(ctx, stranger);
    await ctx.http().put(`${theirs.base}/payroll/settings`).set(stranger.auth).send({}).expect(200);
    expect((await ctx.http().get(`${theirs.base}/payroll/leave?year=${YEAR}`).set(stranger.auth).expect(200)).body).toEqual([]);
    await ctx.http().post(`${theirs.base}/payroll/leave`).set(stranger.auth).send({ employeeId: emp, leaveTypeId: types.EL, from: `${MAY}-20`, to: `${MAY}-20`, days: '1' }).expect(404);
  });
});
