import { D } from '@talk2tax/accounting-engine';
import { pfContributions } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

// Months inside the fiscal year created at onboarding (April to March of the current year).
const t = today();
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const APR = `${FY}-04`;
const MAY = `${FY}-05`;

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const emp: Record<string, { id: string }> = {};
const runs: Record<string, Run> = {};

interface Slip {
  employee: { id: string; code: string };
  gross: string;
  wages: string;
  wagesAddedBack: string;
  paidDays: string;
  daysOutside: string;
  lopDays: string;
  pf: { wages: string; employee: string; eps: string; epfEmployer: string; edli: string; admin: string };
  esi: { covered: boolean; wages: string; employee: string; employer: string };
  pt: { amount: string };
  tds: { amount: string; annualTax: string; projectedIncome: string };
  deductions: string;
  net: string;
  employerCost: string;
}
interface Run {
  id: string;
  number: string;
  status: string;
  journalEntryId: string | null;
  totals: Record<string, string>;
  liabilities: { liability: string; amount: string; dueDate: string; payment: { id: string; number: string } | null }[];
  payslips: Slip[];
  missing: { name: string }[];
  remittances: { id: string; number: string; liability: string; status: string; journalEntryId: string }[];
}
const slip = (r: Run, code: string) => r.payslips.find((s) => s.employee.code === code)!;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Payroll Owner');
  org = await createOrg(ctx, owner);
});
afterAll(async () => {
  await ctx.app.close();
});

const salary = (from: string, basic: string, hra: string, special = '0') => ({
  effectiveFrom: from,
  components: [
    { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: basic },
    { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthlyAmount: hra },
    ...(special !== '0' ? [{ code: 'SPECIAL', name: 'Special allowance', kind: 'WAGES', monthlyAmount: special }] : []),
  ],
});

describe('setup', () => {
  it('needs payroll settings and creates the payroll accounts', async () => {
    expect((await ctx.http().get(`${org.base}/payroll/settings`).set(owner.auth).expect(200)).body).toEqual({ configured: false });
    expect((await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: APR, payDate: `${APR}-30` }).expect(409)).body.error).toBe('PAYROLL_NOT_CONFIGURED');
    const r = await ctx.http().put(`${org.base}/payroll/settings`).set(owner.auth).send({ pfEstablishmentCode: 'MHBAN0012345000', esiEmployerCode: '31000123450001001' }).expect(200);
    expect(r.body.accounts).toMatchObject({
      salaryExpense: { code: '6100', name: 'Salaries and Wages' },
      employerContribution: { code: '6110', name: 'Employer PF and ESI' },
      netPay: { code: '2410' },
      pfPayable: { code: '2411' },
      esiPayable: { code: '2412' },
      ptPayable: { code: '2413' },
      tdsPayable: { code: '2414' },
    });
    const accounts = (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[];
    for (const a of accounts) org.acc[a.code] = a.id;
  });

  it('adds employees with a salary and validates them', async () => {
    const add = async (k: string, body: Record<string, unknown>) => (emp[k] = (await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send(body).expect(201)).body);
    const asha = await add('asha', { code: 'E001', name: 'Asha Kulkarni', pan: 'zzzpk1001z', dateOfJoining: `${APR}-01`, workStateCode: '27', uan: '100200300400', structure: salary(`${APR}-01`, '60000', '30000', '20000') });
    expect(asha).toMatchObject({ code: 'E001', pan: 'ZZZPK1001Z', pfMember: true, epsMember: true, ptCategory: 'GENERAL', currentSalary: { monthlyGross: '110000.00' } });
    await add('ravi', { code: 'E002', name: 'Ravi More', dateOfJoining: `${APR}-01`, workStateCode: '27', structure: salary(`${APR}-01`, '10000', '15000') });
    await add('neha', { code: 'E003', name: 'Neha Joshi', dateOfJoining: `${MAY}-16`, workStateCode: '27', ptCategory: 'WOMAN', pfMember: false, epsMember: false, structure: { effectiveFrom: `${MAY}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '24000' }] } });

    const bad = await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'E009', name: 'X', pan: 'ABC', dateOfJoining: `${APR}-01`, structure: salary(`${APR}-01`, '1000', '0') }).expect(422);
    expect(bad.body.details.issues.join(' ')).toMatch(/PAN/);
    const noWages = await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'E009', name: 'X', dateOfJoining: `${APR}-01`, structure: { effectiveFrom: `${APR}-01`, components: [{ code: 'HRA', name: 'HRA', kind: 'EXCLUDED', monthlyAmount: '1000' }] } }).expect(422);
    expect(noWages.body.details.issues.join(' ')).toMatch(/basic pay/);
    expect((await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'E001', name: 'Dup', dateOfJoining: `${APR}-01`, structure: salary(`${APR}-01`, '1000', '0') }).expect(409)).body.error).toBe('DUPLICATE_EMPLOYEE_CODE');
    await ctx.http().post(`${org.base}/payroll/employees/${emp.asha.id}/salaries`).set(owner.auth).send(salary(`${APR}-15`, '1', '0')).expect(422);
  });
});

describe('April pay run', () => {
  it('works out payslips for everyone employed in the month', async () => {
    const r = (runs.apr = (await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: APR, payDate: `${APR}-30` }).expect(201)).body);
    expect(r).toMatchObject({ number: 'PAY-000001', status: 'DRAFT' });
    expect(r.payslips.map((s: Slip) => s.employee.code)).toEqual(['E001', 'E002']);
    const a = slip(r, 'E001');
    const pf = pfContributions(APR, new D('80000'), { member: true, eps: true, onFullWages: false });
    expect(a).toMatchObject({ gross: '110000.00', wages: '80000.00', paidDays: '30.0', pt: { amount: '200.00' } });
    expect(a.pf).toEqual({ wages: pf.wages.toFixed(2), employee: pf.employee.toFixed(2), eps: pf.eps.toFixed(2), epfEmployer: pf.epfEmployer.toFixed(2), edli: pf.edli.toFixed(2), admin: pf.admin.toFixed(2) });
    // Projected 13.2 lakh, taxable 12.45 lakh: 46,800 for the year, spread over 12 months.
    expect(a.tds).toMatchObject({ amount: '3900.00', annualTax: '46800.00', projectedIncome: '1320000.00' });
    expect(a.esi.covered).toBe(false);

    // Ravi: HRA is more than half his pay, so the excess counts as wages (12,500); ESI covers him.
    const b = slip(r, 'E002');
    expect(b).toMatchObject({ gross: '25000.00', wages: '12500.00', wagesAddedBack: '2500.00', esi: { covered: true, wages: '12500.00', employee: '94.00', employer: '407.00' }, tds: { amount: '0.00' } });
    expect((await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: APR, payDate: `${APR}-30` }).expect(409)).body.error).toBe('PAY_RUN_EXISTS');
  });

  it('adjusts loss-of-pay days and one-off earnings on a draft', async () => {
    const r = (runs.apr = (await ctx.http().put(`${org.base}/payroll/runs/${runs.apr.id}/payslips/${emp.ravi.id}`).set(owner.auth).send({ lopDays: '3', oneOffs: [{ name: 'Joining bonus', kind: 'EXCLUDED', amount: '1000' }] }).expect(200)).body);
    const b = slip(r, 'E002');
    // 27 of 30 days: 9,000 basic and 13,500 HRA, plus the bonus.
    expect(b).toMatchObject({ lopDays: '3.0', paidDays: '27.0', gross: '23500.00' });
    expect(r.totals.gross).toBe(new D('110000').plus('23500').toFixed(2));
    const tooMany = await ctx.http().put(`${org.base}/payroll/runs/${runs.apr.id}/payslips/${emp.ravi.id}`).set(owner.auth).send({ lopDays: '31', oneOffs: [] }).expect(422);
    expect(tooMany.body.error).toBe('INVALID_PAYSLIP');
  });

  it('posts one balanced journal for the month', async () => {
    const r = (runs.apr = (await ctx.http().post(`${org.base}/payroll/runs/${runs.apr.id}/post`).set(owner.auth).expect(200)).body);
    expect(r.status).toBe('POSTED');
    const j = (await ctx.http().get(`${org.base}/journals/${r.journalEntryId}`).set(owner.auth).expect(200)).body as { date: string; source: string; lines: { accountId: string; debit: string; credit: string }[] };
    expect(j).toMatchObject({ date: `${APR}-30`, source: 'PAYROLL' });
    const line = (code: string) => j.lines.find((l) => l.accountId === org.acc[code]);
    const tt = r.totals;
    expect(line('6100')!.debit).toBe(tt.gross);
    expect(line('6110')!.debit).toBe(new D(tt.employerCost).minus(tt.gross).toFixed(2));
    expect(line('2410')!.credit).toBe(tt.net);
    expect(line('2411')!.credit).toBe(new D(tt.pfEmployee).plus(tt.pfEmployer).plus(tt.edli).plus(tt.pfAdmin).toFixed(2));
    expect(line('2412')!.credit).toBe(new D(tt.esiEmployee).plus(tt.esiEmployer).toFixed(2));
    expect(line('2413')!.credit).toBe('400.00');
    expect(line('2414')!.credit).toBe('3900.00');
    expect(r.liabilities.map((l: Run['liabilities'][number]) => [l.liability, l.dueDate])).toEqual([
      ['NET_PAY', `${APR}-30`],
      ['PF', `${MAY}-15`],
      ['ESI', `${MAY}-15`],
      ['PT', `${MAY}-31`],
      ['TDS', `${MAY}-07`],
    ]);
  });

  it('freezes posted payslips and the salaries they used', async () => {
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE payslips SET net = 1 WHERE pay_run_id = '${runs.apr.id}'`)).rejects.toThrow(/cannot change|check constraint/);
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE payslips SET tds = tds WHERE pay_run_id = '${runs.apr.id}'`)).rejects.toThrow(/posted pay run cannot change/);
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE salary_components SET monthly_amount = 1`)).rejects.toThrow(/cannot change/);
    expect((await ctx.http().post(`${org.base}/payroll/employees/${emp.asha.id}/salaries`).set(owner.auth).send(salary(`${APR}-01`, '1000', '0')).expect(409)).body.error).toBe('STRUCTURE_USED');
    expect((await ctx.http().put(`${org.base}/payroll/employees/${emp.asha.id}`).set(owner.auth).send({ code: 'E001', name: 'Asha Kulkarni', dateOfJoining: `${APR}-02` }).expect(409)).body.error).toBe('EMPLOYEE_PAID');
    expect((await ctx.http().put(`${org.base}/payroll/runs/${runs.apr.id}/payslips/${emp.ravi.id}`).set(owner.auth).send({ lopDays: '0', oneOffs: [] }).expect(409)).body.error).toBe('PAY_RUN_POSTED');
  });
});

describe('May pay run', () => {
  it('includes a mid-month joiner and carries tax and ESI history forward', async () => {
    // Asha's raise from May: basic 70,000.
    await ctx.http().post(`${org.base}/payroll/employees/${emp.asha.id}/salaries`).set(owner.auth).send(salary(`${MAY}-01`, '70000', '30000', '20000')).expect(201);
    const r = (runs.may = (await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: MAY, payDate: `${MAY}-31` }).expect(201)).body);
    expect(r.payslips.map((s: Slip) => s.employee.code)).toEqual(['E001', 'E002', 'E003']);
    // Projected 1,10,000 (April) + 1,20,000 + 10 × 1,20,000 = 14.3 lakh; tax 86,580 less 3,900 deducted, over 11 months.
    expect(slip(r, 'E001').tds).toMatchObject({ amount: '7516.00', annualTax: '86580.00', projectedIncome: '1430000.00' });
    // Neha joined on the 16th: 16 of 31 days, no PF (not a member), and below Maharashtra's limit for women.
    expect(slip(r, 'E003')).toMatchObject({ daysOutside: '15.0', paidDays: '16.0', gross: '12387.10', pf: { employee: '0.00' }, pt: { amount: '0.00' } });
    // Ravi stays covered by ESI for the April–September period.
    expect(slip(r, 'E002').esi.covered).toBe(true);
    runs.may = (await ctx.http().post(`${org.base}/payroll/runs/${runs.may.id}/post`).set(owner.auth).expect(200)).body;
  });
});

describe('paying out', () => {
  it('pays net salaries and statutory dues once each', async () => {
    const pay = (run: Run, liability: string, reference: string) => ctx.http().post(`${org.base}/payroll/runs/${run.id}/payments`).set(owner.auth).send({ liability, date: `${MAY}-05`, bankAccountId: org.acc['1120'], reference });
    let r = (await pay(runs.apr, 'NET_PAY', 'NEFT batch APR').expect(201)).body as Run;
    const net = r.remittances[0];
    expect(net).toMatchObject({ number: 'PAYP-000001', liability: 'NET_PAY', status: 'POSTED' });
    const j = (await ctx.http().get(`${org.base}/journals/${net.journalEntryId}`).set(owner.auth).expect(200)).body as { lines: { accountId: string; debit: string; credit: string }[] };
    expect(j.lines.find((l) => l.accountId === org.acc['2410'])!.debit).toBe(runs.apr.totals.net);
    expect(j.lines.find((l) => l.accountId === org.acc['1120'])!.credit).toBe(runs.apr.totals.net);
    r = (await pay(runs.apr, 'TDS', 'CIN 0510308 APR (synthetic)').expect(201)).body;
    expect(r.liabilities.find((l) => l.liability === 'TDS')!.payment).toMatchObject({ number: 'PAYP-000002' });
    expect((await pay(runs.apr, 'TDS', 'again').expect(409)).body.error).toBe('ALREADY_PAID');
    expect((await pay(runs.may, 'NET_PAY', 'too early').expect(422)).body.error).toBe('INVALID_DATE');
    runs.apr = r;
  });

  it('voids in order: later runs first, and payments before their run', async () => {
    expect((await ctx.http().post(`${org.base}/payroll/runs/${runs.apr.id}/void`).set(owner.auth).send({ reason: 'Wrong month' }).expect(409)).body.error).toBe('LATER_PAY_RUN');
    await ctx.http().post(`${org.base}/payroll/runs/${runs.may.id}/void`).set(owner.auth).send({ reason: 'Recalculate after correction' }).expect(200);
    expect((await ctx.http().post(`${org.base}/payroll/runs/${runs.apr.id}/void`).set(owner.auth).send({ reason: 'Wrong month' }).expect(409)).body.error).toBe('PAY_RUN_PAID');
    for (const p of runs.apr.remittances) await ctx.http().post(`${org.base}/payroll/runs/${runs.apr.id}/payments/${p.id}/void`).set(owner.auth).send({ reason: 'Bounced' }).expect(200);
    const v = (await ctx.http().post(`${org.base}/payroll/runs/${runs.apr.id}/void`).set(owner.auth).send({ reason: 'Wrong month' }).expect(200)).body;
    expect(v.status).toBe('VOID');
    // A voided month can be run again.
    const again = (await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: APR, payDate: `${APR}-30` }).expect(201)).body;
    expect(again.number).toBe('PAY-000003');
    await ctx.http().delete(`${org.base}/payroll/runs/${again.id}`).set(owner.auth).expect(200);
  });
});

describe('access', () => {
  it('keeps salaries from viewers and other organisations', async () => {
    const viewer = await registerUser(ctx, 'Viewer');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    await ctx.http().get(`${org.base}/payroll/employees`).set(viewer.auth).expect(403);
    await ctx.http().get(`${org.base}/payroll/runs/${runs.apr.id}`).set(viewer.auth).expect(403);
    const other = await registerUser(ctx, 'Other');
    const otherOrg = await createOrg(ctx, other);
    await ctx.http().get(`${otherOrg.base}/payroll/runs/${runs.apr.id}`).set(other.auth).expect(404);
    await ctx.http().get(`${otherOrg.base}/payroll/employees/${emp.asha.id}`).set(other.auth).expect(404);
    await ctx.http().get(`${otherOrg.base}/payroll/runs/${runs.apr.id}/payslips/${emp.asha.id}`).set(other.auth).expect(404);
  });
});
