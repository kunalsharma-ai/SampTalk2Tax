import { describe, expect, it } from 'vitest';
import { buildPayrollReport, payrollReportCsv, type PayrollReportSlip } from '../src/payroll-report';

const slip = (period: string, code: string, gross: string, x: Partial<PayrollReportSlip> = {}): PayrollReportSlip => ({
  period,
  employee: { id: `id-${code}`, code, name: `Employee ${code}` },
  gross,
  pfEmployee: '1800',
  eps: '1250',
  epfEmployer: '550',
  edli: '75',
  pfAdmin: '75',
  esiEmployee: '0',
  esiEmployer: '0',
  pt: '200',
  tds: '0',
  deductions: '2000',
  net: String(Number(gross) - 2000), // not money: test fixture
  employerCost: String(Number(gross) + 1950), // not money: test fixture
  ...x,
});

const slips = [
  slip('2026-04', 'E1', '30000'),
  slip('2026-04', 'E2', '20000', { pfEmployee: '1800', esiEmployee: '150', esiEmployer: '650', deductions: '2150', net: '17850', employerCost: '22600' }),
  slip('2026-05', 'E1', '30000', { tds: '1000', deductions: '3000', net: '27000' }),
  slip('2026-05', 'E2', '20000', { esiEmployee: '150', esiEmployer: '650', deductions: '2150', net: '17850', employerCost: '22600' }),
  slip('2026-06', 'E1', '30000'),
];

describe('payroll reports (RPT-010)', () => {
  const r = buildPayrollReport(slips, 'INR');

  it('totals the posted payslips and the statutory amounts', () => {
    expect(r.totals).toEqual({ employees: 2, payslips: 5, months: 3, gross: '130000.00', deductions: '11300.00', net: '118700.00', employerCost: '141050.00', employerContributions: '11050.00' });
    expect(r.statutory).toEqual([
      { key: 'PF', label: 'Provident fund', employee: '9000.00', employer: '9750.00', total: '18750.00' },
      { key: 'ESI', label: 'Employees’ State Insurance', employee: '300.00', employer: '1300.00', total: '1600.00' },
      { key: 'PT', label: 'Professional tax', employee: '1000.00', employer: '0.00', total: '1000.00' },
      { key: 'TDS', label: 'TDS on salary', employee: '1000.00', employer: '0.00', total: '1000.00' },
    ]);
  });

  it('gives each month with the change in gross, flagging large swings', () => {
    expect(r.byMonth.map((x) => [x.period, x.employees, x.gross, x.pf, x.esi, x.grossChange, x.flagged])).toEqual([
      ['2026-04', 2, '50000.00', '7500.00', '800.00', null, false],
      ['2026-05', 2, '50000.00', '7500.00', '800.00', '0.0', false],
      ['2026-06', 1, '30000.00', '3750.00', '0.00', '-40.0', true],
    ]);
  });

  it('gives each employee, and writes a CSV without bank details', () => {
    expect(r.byEmployee.map((e) => [e.code, e.months, e.gross, e.tds, e.net])).toEqual([
      ['E1', 3, '90000.00', '1000.00', '83000.00'],
      ['E2', 2, '40000.00', '0.00', '35700.00'],
    ]);
    const csv = payrollReportCsv(buildPayrollReport([slip('2026-04', 'E9', '1000', { employee: { id: 'x', code: 'E9', name: '=HYPERLINK("x")' } })], 'INR'), { from: '2026-04', to: '2026-06', currency: 'INR' }).trim().split('\n');
    expect(csv[0]).toBe('Payroll report,2026-04 to 2026-06,INR');
    expect(csv).toContain('2026-04,1,1000.00,3750.00,0.00,200.00,0.00,-1000.00,2950.00,');
    expect(csv.at(-1)).toBe(`E9,"'=HYPERLINK(""x"")",1,1000.00,1800.00,0.00,200.00,0.00,-1000.00,2950.00`);
    expect(buildPayrollReport([], 'INR').totals).toMatchObject({ employees: 0, gross: '0.00' });
  });
});
