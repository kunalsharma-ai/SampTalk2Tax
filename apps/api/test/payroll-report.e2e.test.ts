import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Payroll reports (RPT-010) against the real API and database: two posted pay runs (one employee,
 * then two) and a draft one; totals, statutory amounts, months with the change in gross and
 * employees matching the pay runs; no bank details; the CSV export in the audit trail;
 * validation, permissions and tenants.
 */
const T = today();
const monthOf = (back: number) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const [M2, M1, M0] = [monthOf(2), monthOf(1), monthOf(0)];
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const runs: Record<string, { id: string; totals: Record<string, string> }> = {};
const R = () => `${org.base}/reports/payroll`;
const structure = (from: string, amount: string) => ({ effectiveFrom: `${from}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: amount }] });
const sum = (...xs: string[]) => xs.reduce((s, x) => s + Number(x), 0).toFixed(2); // not money: test check

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Payroll Report Owner');
  viewer = await registerUser(ctx, 'Payroll Report Viewer');
  outsider = await registerUser(ctx, 'Payroll Report Outsider');
  org = await createOrg(ctx, owner, { name: 'Paid People Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Payroll Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const fy of new Set([M2, M1, M0].map((m) => fiscalYearForDate(`${m}-01`, 4)))) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  await ctx.http().put(`${org.base}/payroll/settings`).set(owner.auth).send({}).expect(200);
  await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'E001', name: 'Asha Kulkarni', dateOfJoining: `${M2}-01`, structure: structure(M2, '30000'), bankAccountName: 'Asha Kulkarni', bankAccountNumber: '50100012345678', bankIfsc: 'HDFC0001234' }).expect(201);
  await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send({ code: 'E002', name: 'Ravi Shetty', dateOfJoining: `${M1}-01`, structure: structure(M1, '15000') }).expect(201);
  for (const m of [M2, M1, M0]) {
    const id = (await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: m, payDate: `${m}-28` }).expect(201)).body.id;
    if (m !== M0) await ctx.http().post(`${org.base}/payroll/runs/${id}/post`).set(owner.auth).expect(200);
    runs[m] = (await ctx.http().get(`${org.base}/payroll/runs/${id}`).set(owner.auth).expect(200)).body;
  }
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('payroll report', () => {
  it('totals the posted pay runs, leaving the draft out', async () => {
    const r = (await ctx.http().get(R()).query({ from: M2, to: M0 }).set(owner.auth).expect(200)).body;
    const a = runs[M2]!.totals;
    const b = runs[M1]!.totals;
    expect(r).toMatchObject({ from: M2, to: M0, currency: 'INR', runs: 2, draftRuns: [{ period: M0 }] });
    expect(r.totals).toMatchObject({ employees: 2, payslips: 3, months: 2, gross: '75000.00', net: sum(a.net!, b.net!), deductions: sum(a.deductions!, b.deductions!), employerCost: sum(a.employerCost!, b.employerCost!) });
    expect(r.statutory.map((s: { key: string; employee: string; employer: string }) => [s.key, s.employee, s.employer])).toEqual([
      ['PF', sum(a.pfEmployee!, b.pfEmployee!), sum(a.pfEmployer!, a.edli!, a.pfAdmin!, b.pfEmployer!, b.edli!, b.pfAdmin!)],
      ['ESI', sum(a.esiEmployee!, b.esiEmployee!), sum(a.esiEmployer!, b.esiEmployer!)],
      ['PT', sum(a.pt!, b.pt!), '0.00'],
      ['TDS', sum(a.tds!, b.tds!), '0.00'],
    ]);
  });

  it('gives each month with the change in gross, and each employee without bank details', async () => {
    const r = (await ctx.http().get(R()).query({ from: M2, to: M0 }).set(owner.auth).expect(200)).body;
    expect(r.byMonth.map((x: { period: string; employees: number; gross: string; net: string; grossChange: string | null; flagged: boolean }) => [x.period, x.employees, x.gross, x.net, x.grossChange, x.flagged])).toEqual([
      [M2, 1, '30000.00', runs[M2]!.totals.net, null, false],
      [M1, 2, '45000.00', runs[M1]!.totals.net, '50.0', true],
    ]);
    expect(r.byEmployee.map((e: { code: string; name: string; months: number; gross: string }) => [e.code, e.name, e.months, e.gross])).toEqual([
      ['E001', 'Asha Kulkarni', 2, '60000.00'],
      ['E002', 'Ravi Shetty', 1, '15000.00'],
    ]);
    expect(JSON.stringify(r)).not.toContain('50100012345678');
  });

  it('exports the report as CSV and keeps the export in the audit trail', async () => {
    const x = (await ctx.http().get(`${R()}/export`).query({ from: M2, to: M0 }).set(owner.auth).expect(200)).body;
    expect(x.fileName).toBe(`payroll-report-${M2}-to-${M0}.csv`);
    const rows = (x.csv as string).trim().split('\n');
    expect(rows[0]).toBe(`Payroll report,${M2} to ${M0},INR`);
    expect(rows.some((l) => l.startsWith(`${M1},2,45000.00,`) && l.endsWith(',50.0'))).toBe(true);
    expect(rows.some((l) => l.startsWith('E002,Ravi Shetty,1,15000.00,'))).toBe(true);
    expect(x.csv).not.toContain('50100012345678');
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: 'payroll_report.exported' }).sort({ idNumber: 1 }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ from: M2, to: M0, payslips: 3, gross: '75000.00' });
  });

  it('defaults to the financial year, and checks the months, permissions and tenants', async () => {
    const d = (await ctx.http().get(R()).set(owner.auth).expect(200)).body;
    expect(d.to).toBe(M0);
    expect(d.from).toMatch(/^\d{4}-04$/);
    // E001 is paid in both months, E002 in the later one: count those inside the financial year.
    expect(d.totals.payslips).toBe((M2 >= d.from ? 1 : 0) + (M1 >= d.from ? 2 : 0));
    await ctx.http().get(R()).query({ from: M0, to: M2 }).set(owner.auth).expect(422);
    await ctx.http().get(R()).query({ from: '2020-01', to: M0 }).set(owner.auth).expect(422);
    await ctx.http().get(R()).query({ from: '2026-13' }).set(owner.auth).expect(400);
    await ctx.http().get(R()).set(viewer.auth).expect(403);
    await ctx.http().get(`${R()}/export`).set(viewer.auth).expect(403);
    await ctx.http().get(R()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/reports/payroll`).set(outsider.auth).expect(200)).body).toMatchObject({ runs: 0, byMonth: [], byEmployee: [], totals: { gross: '0.00' } });
  });
});
