/**
 * Payroll reports (RPT-010): posted pay runs over a range of months, from their payslips.
 *
 * - Totals: employees paid, payslips, gross, deductions, net and the cost to the employer.
 * - By month: each pay period with its employees, gross, statutory amounts, net, employer cost
 *   and the change in gross on the month before (a change of VARIANCE_FLAG_PCT or more is flagged).
 * - By employee: months paid and the year's gross, deductions withheld, net and cost.
 * - Statutory: PF (employee share; employer EPF and EPS; EDLI and admin charges), ESI (employee
 *   and employer), professional tax and TDS on salary, what was withheld and what the employer adds.
 * Bank details are never part of the report.
 */
import { D, type Dec, dec, minorUnits, roundToCurrency } from './money';

export const PAYROLL_VARIANCE_FLAG_PCT = 10;

export interface PayrollReportSlip {
  period: string;
  employee: { id: string; code: string; name: string };
  gross: string;
  pfEmployee: string;
  eps: string;
  epfEmployer: string;
  edli: string;
  pfAdmin: string;
  esiEmployee: string;
  esiEmployer: string;
  pt: string;
  tds: string;
  deductions: string;
  net: string;
  employerCost: string;
}

const KEYS = ['gross', 'pfEmployee', 'eps', 'epfEmployer', 'edli', 'pfAdmin', 'esiEmployee', 'esiEmployer', 'pt', 'tds', 'deductions', 'net', 'employerCost'] as const;
type Key = (typeof KEYS)[number];
type Sums = Record<Key, Dec>;
const zero = (): Sums => Object.fromEntries(KEYS.map((k) => [k, new D(0)])) as Sums;
const add = (s: Sums, x: PayrollReportSlip) => {
  for (const k of KEYS) s[k] = s[k].plus(dec(x[k]));
};

export function buildPayrollReport(slips: readonly PayrollReportSlip[], currency: string) {
  const m = minorUnits(currency);
  const show = (v: Dec) => roundToCurrency(v, currency).toFixed(m);
  const total = zero();
  const months = new Map<string, { sums: Sums; employees: Set<string> }>();
  const people = new Map<string, { code: string; name: string; months: Set<string>; sums: Sums }>();
  for (const s of slips) {
    add(total, s);
    const mo = months.get(s.period) ?? { sums: zero(), employees: new Set<string>() };
    add(mo.sums, s);
    mo.employees.add(s.employee.id);
    months.set(s.period, mo);
    const p = people.get(s.employee.id) ?? { code: s.employee.code, name: s.employee.name, months: new Set<string>(), sums: zero() };
    add(p.sums, s);
    p.months.add(s.period);
    people.set(s.employee.id, p);
  }
  const pf = (x: Sums) => x.pfEmployee.plus(x.eps).plus(x.epfEmployer).plus(x.edli).plus(x.pfAdmin);
  const esi = (x: Sums) => x.esiEmployee.plus(x.esiEmployer);
  let previous: Dec | null = null;
  const byMonth = [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, x]) => {
      const change = previous && previous.gt(0) ? x.sums.gross.minus(previous).times(100).div(previous).toDecimalPlaces(1) : null;
      previous = x.sums.gross;
      return {
        period,
        employees: x.employees.size,
        gross: show(x.sums.gross),
        pf: show(pf(x.sums)),
        esi: show(esi(x.sums)),
        pt: show(x.sums.pt),
        tds: show(x.sums.tds),
        net: show(x.sums.net),
        employerCost: show(x.sums.employerCost),
        grossChange: change ? change.toFixed(1) : null,
        flagged: !!change && change.abs().gte(PAYROLL_VARIANCE_FLAG_PCT),
      };
    });
  const byEmployee = [...people.entries()]
    .sort((a, b) => a[1].code.localeCompare(b[1].code))
    .map(([id, p]) => ({ id, code: p.code, name: p.name, months: p.months.size, gross: show(p.sums.gross), pfEmployee: show(p.sums.pfEmployee), esiEmployee: show(p.sums.esiEmployee), pt: show(p.sums.pt), tds: show(p.sums.tds), deductions: show(p.sums.deductions), net: show(p.sums.net), employerCost: show(p.sums.employerCost) }));
  const statutory = [
    { key: 'PF', label: 'Provident fund', employee: total.pfEmployee, employer: total.eps.plus(total.epfEmployer).plus(total.edli).plus(total.pfAdmin) },
    { key: 'ESI', label: 'Employees’ State Insurance', employee: total.esiEmployee, employer: total.esiEmployer },
    { key: 'PT', label: 'Professional tax', employee: total.pt, employer: new D(0) },
    { key: 'TDS', label: 'TDS on salary', employee: total.tds, employer: new D(0) },
  ].map((s) => ({ key: s.key, label: s.label, employee: show(s.employee), employer: show(s.employer), total: show(s.employee.plus(s.employer)) }));
  return {
    totals: {
      employees: people.size,
      payslips: slips.length,
      months: months.size,
      gross: show(total.gross),
      deductions: show(total.deductions),
      net: show(total.net),
      employerCost: show(total.employerCost),
      employerContributions: show(total.employerCost.minus(total.gross)),
    },
    statutory,
    byMonth,
    byEmployee,
  };
}

export type PayrollReport = ReturnType<typeof buildPayrollReport>;

/** The report as CSV, one block per table, with formula-like text guarded. */
export function payrollReportCsv(r: PayrollReport, period: { from: string; to: string; currency: string }): string {
  const risky = (v: string) => /^[=+@]/.test(v) || /^-(?!\d)/.test(v);
  const q = (v: string) => {
    const t = risky(v) ? `'${v}` : v;
    return risky(v) || /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const out: string[] = [];
  const row = (...cells: (string | number)[]) => out.push(cells.map((c) => q(String(c))).join(','));
  row('Payroll report', `${period.from} to ${period.to}`, period.currency);
  row('');
  row('Month', 'Employees', 'Gross', 'PF', 'ESI', 'Professional tax', 'TDS', 'Net', 'Employer cost', 'Change in gross %');
  for (const x of r.byMonth) row(x.period, x.employees, x.gross, x.pf, x.esi, x.pt, x.tds, x.net, x.employerCost, x.grossChange ?? '');
  row('Total', r.totals.employees, r.totals.gross, '', '', '', '', r.totals.net, r.totals.employerCost, '');
  row('');
  row('Statutory', 'Withheld from employees', 'Paid by the employer', 'Total');
  for (const s of r.statutory) row(s.label, s.employee, s.employer, s.total);
  row('');
  row('Code', 'Employee', 'Months', 'Gross', 'PF', 'ESI', 'Professional tax', 'TDS', 'Net', 'Employer cost');
  for (const e of r.byEmployee) row(e.code, e.name, e.months, e.gross, e.pfEmployee, e.esiEmployee, e.pt, e.tds, e.net, e.employerCost);
  return `${out.join('\n')}\n`;
}
