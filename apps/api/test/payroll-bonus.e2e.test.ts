import { D } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Statutory bonus (PAY-007) from posted payslips, paid as a one-off earning on a
 * draft pay run: first as an advance during the year, then the balance.
 */
const t = today();
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const YEAR = `${FY}-${String((FY + 1) % 100).padStart(2, '0')}`;
const [APR, MAY, JUN, JUL] = ['04', '05', '06', '07'].map((m) => `${FY}-${m}`);

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const emp: Record<string, string> = {};
const runs: Record<string, string> = {};

interface Row {
  code: string;
  eligible: boolean;
  reason: string | null;
  bonusWages: string;
  bonus: string;
  paid: { amount: string; runs: string[] };
  due: string;
}
const report = async (q = `year=${YEAR}&ratePct=8.33`) => (await ctx.http().get(`${org.base}/payroll/bonus?${q}`).set(owner.auth).expect(200)).body as { employees: Row[]; totals: Record<string, unknown>; eligibilityCeiling: string; calculationCeiling: string };
const row = (r: { employees: Row[] }, code: string) => r.employees.find((x) => x.code === code)!;
const structure = (from: string, basic: string, hra = '0') => ({
  effectiveFrom: from,
  components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: basic }, ...(hra !== '0' ? [{ code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthlyAmount: hra }] : [])],
});
const newRun = async (period: string) => (await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period, payDate: `${period}-28` }).expect(201)).body.id as string;
const post = (id: string) => ctx.http().post(`${org.base}/payroll/runs/${id}/post`).set(owner.auth).expect(200);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Bonus Owner');
  viewer = await registerUser(ctx, 'Bonus Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().put(`${org.base}/payroll/settings`).set(owner.auth).send({}).expect(200);
  const add = async (code: string, body: Record<string, unknown>) => (emp[code] = (await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code, ...body }).expect(201)).body.id);
  await add('B001', { name: 'Kiran Patil', dateOfJoining: `${APR}-01`, structure: structure(`${APR}-01`, '12000', '5000') });
  await add('B002', { name: 'Meera Rao', dateOfJoining: `${APR}-01`, structure: structure(`${APR}-01`, '30000') });
  await add('B003', { name: 'Sunil Jadhav', dateOfJoining: `${MAY}-18`, structure: structure(`${MAY}-01`, '6000') });
  for (const p of [APR, MAY]) await post((runs[p] = await newRun(p)));
});
afterAll(async () => {
  await ctx.app.close();
});

describe('statutory bonus', () => {
  it('works out the bonus from posted payslips', async () => {
    const r = await report();
    expect(r).toMatchObject({ eligibilityCeiling: '21000.00', calculationCeiling: '7000.00' });
    // Two months at the 7,000 ceiling: 14,000 x 8.33%.
    expect(row(r, 'B001')).toMatchObject({ eligible: true, bonusWages: '14000.00', bonus: '1166.20', due: '1166.20', paid: { amount: '0.00', runs: [] } });
    expect(row(r, 'B002')).toMatchObject({ eligible: false, reason: 'Wages were above 21000 a month all year', due: '0.00' });
    // 14 days in May.
    expect(row(r, 'B003')).toMatchObject({ eligible: false, reason: 'Worked fewer than 30 days in the year' });
    expect(r.totals).toMatchObject({ eligible: 1, bonus: '1166.20', due: '1166.20' });
    // A higher eligibility amount and ceiling (for example a state minimum wage) change the result.
    const wider = await report(`year=${YEAR}&ratePct=20&eligibilityCeiling=35000&calculationCeiling=10000`);
    expect(row(wider, 'B002')).toMatchObject({ eligible: true, bonusWages: '20000.00', bonus: '4000.00' });
    // Pay is private: viewers cannot see it.
    await ctx.http().get(`${org.base}/payroll/bonus?year=${YEAR}&ratePct=8.33`).set(viewer.auth).expect(403);
  });

  it('refuses a rate outside 8.33% to 20% or a malformed year', async () => {
    expect((await ctx.http().get(`${org.base}/payroll/bonus?year=${YEAR}&ratePct=8`).set(owner.auth).expect(422)).body).toMatchObject({ error: 'INVALID_BONUS' });
    expect((await ctx.http().get(`${org.base}/payroll/bonus?year=${FY}-99&ratePct=10`).set(owner.auth).expect(422)).body.error).toBe('INVALID_BONUS');
    await ctx.http().get(`${org.base}/payroll/bonus?year=${YEAR}`).set(owner.auth).expect(400);
  });

  it('adds an advance to a draft run, excluded from wages', async () => {
    runs[JUN] = await newRun(JUN);
    await ctx.http().post(`${org.base}/payroll/runs/${runs[JUN]}/bonus`).set(viewer.auth).send({ year: YEAR, ratePct: '8.33' }).expect(403);
    const res = (await ctx.http().post(`${org.base}/payroll/runs/${runs[JUN]}/bonus`).set(owner.auth).send({ year: YEAR, ratePct: '8.33' }).expect(200)).body;
    expect(res.added).toEqual([{ employeeId: emp.B001, name: 'Kiran Patil', amount: '1166.20' }]);
    expect(res.skipped.map((s: { name: string; reason: string }) => `${s.name}: ${s.reason}`)).toEqual(['Meera Rao: Wages were above 21000 a month all year', 'Sunil Jadhav: Worked fewer than 30 days in the year']);
    const slip = res.run.payslips.find((s: { employee: { code: string } }) => s.employee.code === 'B001');
    expect(slip).toMatchObject({ gross: new D('17000').plus('1166.20').toFixed(2), wages: '12000.00', oneOffs: [{ name: `Statutory bonus ${YEAR}`, kind: 'EXCLUDED', amount: '1166.20' }] });
    // Adding again replaces the line instead of doubling it.
    const again = (await ctx.http().post(`${org.base}/payroll/runs/${runs[JUN]}/bonus`).set(owner.auth).send({ year: YEAR, ratePct: '8.33', employeeIds: [emp.B001] }).expect(200)).body;
    expect(again.run.payslips.find((s: { employee: { code: string } }) => s.employee.code === 'B001').oneOffs).toHaveLength(1);
    // Nothing to add for people who are not eligible.
    expect((await ctx.http().post(`${org.base}/payroll/runs/${runs[JUN]}/bonus`).set(owner.auth).send({ year: YEAR, ratePct: '8.33', employeeIds: [emp.B002] }).expect(422)).body.error).toBe('NO_BONUS_TO_ADD');
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=pay_run&entityId=${runs[JUN]}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit).map((e: { action: string }) => e.action)).toContain('payroll.bonus_added');
  });

  it('counts what was paid and adds only the balance later', async () => {
    await post(runs[JUN]);
    // Posted runs cannot take a bonus.
    expect((await ctx.http().post(`${org.base}/payroll/runs/${runs[JUN]}/bonus`).set(owner.auth).send({ year: YEAR, ratePct: '8.33' }).expect(409)).body.error).toBe('PAY_RUN_POSTED');
    const r = await report();
    const runNo = row(r, 'B001').paid.runs[0];
    // Three months now: 21,000 x 8.33% = 1,749.30, of which 1,166.20 is paid.
    expect(row(r, 'B001')).toMatchObject({ bonus: '1749.30', paid: { amount: '1166.20', runs: [runNo] }, due: '583.10' });
    // Sunil has 14 + 30 days now.
    expect(row(r, 'B003')).toMatchObject({ eligible: true, bonusWages: '8709.68', due: '725.52' });
    runs[JUL] = await newRun(JUL);
    const res = (await ctx.http().post(`${org.base}/payroll/runs/${runs[JUL]}/bonus`).set(owner.auth).send({ year: YEAR, ratePct: '8.33' }).expect(200)).body;
    expect(res.added.map((a: { name: string; amount: string }) => `${a.name} ${a.amount}`)).toEqual(['Kiran Patil 583.10', 'Sunil Jadhav 725.52']);
    await post(runs[JUL]);
    // July's wages earn July's share.
    expect(row(await report(), 'B001')).toMatchObject({ bonus: '2332.40', paid: { amount: '1749.30' }, due: '583.10' });
    // Worked out on a lower ceiling, more has been paid than is due: nothing more, never a negative amount.
    const lower = `year=${YEAR}&ratePct=8.33&calculationCeiling=5000`;
    expect(row(await report(lower), 'B001')).toMatchObject({ bonus: '1666.00', due: '0.00' });
    runs.AUG = await newRun(`${FY}-08`);
    const none = await ctx.http().post(`${org.base}/payroll/runs/${runs.AUG}/bonus`).set(owner.auth).send({ year: YEAR, ratePct: '8.33', calculationCeiling: '5000', employeeIds: [emp.B001] }).expect(422);
    expect(none.body.message).toMatch(/Kiran Patil: Already paid in PAY-\d+, PAY-\d+/);
  });

  it('cannot pay a year that starts after the run', async () => {
    const next = `${FY + 1}-${String((FY + 2) % 100).padStart(2, '0')}`;
    expect((await ctx.http().post(`${org.base}/payroll/runs/${runs[JUL]}/bonus`).set(owner.auth).send({ year: next, ratePct: '8.33' }).expect(409)).body.error).toBe('PAY_RUN_POSTED');
    expect((await ctx.http().post(`${org.base}/payroll/runs/${runs.AUG}/bonus`).set(owner.auth).send({ year: next, ratePct: '8.33' }).expect(409)).body.error).toBe('INVALID_BONUS');
  });
});
