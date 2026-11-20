import { D, dec } from '@talk2tax/accounting-engine';
import { describe, expect, it } from 'vitest';
import { computePayslip, esiContributionPeriodStart, monthsLeftInTaxYear, PayComponentInput, PayslipInput, PayslipResult } from '../src';

/**
 * Payroll calculation tests (QA-010): whole tax years run month by month, each payslip fed the
 * history of the ones before it, as the API does. Expected figures are worked out by hand from
 * the rules in force for each month; every payslip is also checked against the identities that
 * must always hold (net = gross − deductions, employer cost, PF split).
 */

const MONTHS_2026_27 = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const days = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();

interface Employee {
  salary: (period: string) => PayComponentInput[];
  pf: PayslipInput['pf'];
  pt: PayslipInput['pt'];
  hasPan?: boolean;
  /** Month of leaving (paid that month, nothing after). */
  leaves?: string;
  paidDays?: (period: string) => string;
}

/** Runs the months in order, carrying tax and ESI history forward. */
function runYear(e: Employee, months = MONTHS_2026_27) {
  const slips: { period: string; r: PayslipResult }[] = [];
  let incomeBefore = new D(0);
  let tdsBefore = new D(0);
  const esiByPeriod = new Map<string, boolean>();
  for (const period of months) {
    if (e.leaves && period > e.leaves) break;
    // As the API does: a known leaving date limits the months still to be paid.
    const monthIndex = (p: string) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7));
    const future = e.leaves ? Math.min(monthsLeftInTaxYear(period) - 1, monthIndex(e.leaves) - monthIndex(period)) : monthsLeftInTaxYear(period) - 1;
    const r = computePayslip({
      period,
      paidDays: e.paidDays?.(period) ?? String(days(period)),
      components: e.salary(period),
      pf: e.pf,
      esiCoveredForPeriod: esiByPeriod.get(esiContributionPeriodStart(period)) ?? null,
      pt: e.pt,
      tax: { incomeBefore: incomeBefore.toFixed(2), tdsBefore: tdsBefore.toFixed(2), futureMonths: future, hasPan: e.hasPan ?? true },
    });
    if (!esiByPeriod.has(esiContributionPeriodStart(period))) esiByPeriod.set(esiContributionPeriodStart(period), r.esi.covered);
    incomeBefore = incomeBefore.plus(r.gross);
    tdsBefore = tdsBefore.plus(r.tds.amount);
    slips.push({ period, r });
  }
  return slips;
}

const sum = (slips: { r: PayslipResult }[], pick: (r: PayslipResult) => string) => slips.reduce((s, x) => s.plus(pick(x.r)), new D(0)).toFixed(2);

function checkIdentities(r: PayslipResult) {
  const g = dec(r.gross);
  expect(dec(r.deductions).eq(dec(r.pf.employee).plus(r.esi.employee).plus(r.pt.amount).plus(r.tds.amount))).toBe(true);
  expect(dec(r.net).eq(g.minus(r.deductions))).toBe(true);
  expect(dec(r.employerCost).eq(g.plus(r.pf.eps).plus(r.pf.epfEmployer).plus(r.pf.edli).plus(r.pf.admin).plus(r.esi.employer))).toBe(true);
  // The employer's 12% is split between EPS and EPF, never more.
  expect(dec(r.pf.eps).plus(r.pf.epfEmployer).eq(dec(r.pf.wages).times('0.12').toDecimalPlaces(0, D.ROUND_HALF_UP))).toBe(true);
  expect(g.eq(r.earnings.reduce((s, e) => s.plus(e.amount), new D(0)))).toBe(true);
  for (const v of [r.net, r.tds.amount, r.pf.employee, r.esi.employee, r.pt.amount]) expect(dec(v).gte(0)).toBe(true);
}

describe('a salaried employee through tax year 2026-27', () => {
  // Rs 1,10,000 a month (80,000 of it wages) until a raise in October to Rs 1,20,000.
  const salary = (period: string): PayComponentInput[] => [
    { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: period >= '2026-10' ? '70000' : '60000' },
    { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthly: '30000' },
    { code: 'SPECIAL', name: 'Special allowance', kind: 'WAGES', monthly: '20000' },
  ];
  const slips = runYear({ salary, pf: { member: true, eps: true, onFullWages: false }, pt: { stateCode: '27', category: 'GENERAL' } });
  const at = (p: string) => slips.find((s) => s.period === p)!.r;

  it('holds the payslip identities every month', () => {
    expect(slips).toHaveLength(12);
    for (const s of slips) checkIdentities(s.r);
  });

  it('deducts exactly the year\'s income tax by March, after the raise', () => {
    // 6 x 1,10,000 + 6 x 1,20,000 = 13,80,000; taxable 13,05,000.
    // Slab tax 20,000 + 40,000 + 15,750 = 75,750 (below the 1,05,000 above Rs 12 lakh, so no relief); cess 3,030.
    expect(sum(slips, (r) => r.gross)).toBe('1380000.00');
    expect(at('2027-03').tds.annualTax).toBe('78780.00');
    expect(sum(slips, (r) => r.tds.amount)).toBe('78780.00');
    // Before the raise the projection is 13.2 lakh: 46,800 a year, 3,900 a month.
    expect(at('2026-04').tds.amount).toBe('3900.00');
    // From October the rest (78,780 − 6 x 3,900 = 55,380) is spread over the six months left.
    expect(at('2026-10').tds.amount).toBe('9230.00');
  });

  it('caps PF at Rs 15,000 to 16 September and Rs 25,000 after, by days in September', () => {
    expect(at('2026-04').pf).toMatchObject({ wages: '15000.00', employee: '1800.00', eps: '1250.00', epfEmployer: '550.00', edli: '75.00', admin: '75.00' });
    // September: 15,000 x 16/30 + 25,000 x 14/30 = 19,666.67, rounded to 19,667.
    expect(at('2026-09').pf).toMatchObject({ wages: '19667.00', employee: '2360.00', eps: '1638.00' });
    expect(at('2026-10').pf).toMatchObject({ wages: '25000.00', employee: '3000.00', eps: '2083.00', epfEmployer: '917.00' });
    expect(sum(slips, (r) => r.pf.employee)).toBe('29360.00'); // 5 x 1,800 + 2,360 + 6 x 3,000
  });

  it('takes Maharashtra professional tax of Rs 2,500 for the year (Rs 300 in February)', () => {
    expect(at('2027-02').pt.amount).toBe('300.00');
    expect(sum(slips, (r) => r.pt.amount)).toBe('2500.00');
  });

  it('is not covered by ESI at these wages', () => {
    for (const s of slips) expect(s.r.esi.covered).toBe(false);
  });
});

describe('an employee near the ESI limit', () => {
  // Rs 20,000 to June, Rs 22,000 from July.
  const salary = (period: string): PayComponentInput[] => [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: period >= '2026-07' ? '22000' : '20000' }];
  const slips = runYear({ salary, pf: { member: false, eps: false, onFullWages: false }, pt: { stateCode: '27', category: 'GENERAL' } });
  const esi = slips.map((s) => s.r.esi.employee);

  it('stays covered for the rest of the April–September period after crossing Rs 21,000, and drops out from October', () => {
    // 0.75% of 20,000 = 150; of 22,000 = 165. Employer 3.25%: 650 and 715.
    expect(esi).toEqual(['150.00', '150.00', '150.00', '165.00', '165.00', '165.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00']);
    expect(slips[3].r.esi).toMatchObject({ covered: true, employer: '715.00' });
    expect(slips[6].r.esi.covered).toBe(false);
    for (const s of slips) checkIdentities(s.r);
  });

  it('deducts no income tax within the rebate', () => {
    expect(sum(slips, (r) => r.tds.amount)).toBe('0.00');
    expect(sum(slips, (r) => r.gross)).toBe('258000.00');
  });
});

describe('a woman in Maharashtra, with loss of pay', () => {
  const salary = (): PayComponentInput[] => [
    { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '31000' },
    { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthly: '15500' },
  ];
  const slips = runYear({
    salary,
    pf: { member: true, eps: true, onFullWages: false },
    pt: { stateCode: '27', category: 'WOMAN' },
    paidDays: (p) => (p === '2026-07' ? '15.5' : String(days(p))),
  });

  it('pro-rates the month by paid days, half days included', () => {
    const july = slips.find((s) => s.period === '2026-07')!.r;
    // 31,000 x 15.5/31 = 15,500 and 15,500 x 15.5/31 = 7,750.
    expect(july.earnings.map((e) => e.amount)).toEqual(['15500.00', '7750.00']);
    expect(july.gross).toBe('23250.00');
    // Below Rs 25,000 in that month, so no professional tax for a woman.
    expect(july.pt.amount).toBe('0.00');
    expect(july.pf.employee).toBe('1800.00');
  });

  it('charges Rs 200 (Rs 300 in February) in the other months', () => {
    expect(sum(slips, (r) => r.pt.amount)).toBe('2300.00'); // 10 x 200 + 300
    for (const s of slips) checkIdentities(s.r);
  });
});

describe('an employee who leaves mid-year', () => {
  const salary = (): PayComponentInput[] => [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '200000' }];
  const slips = runYear({ salary, pf: { member: false, eps: false, onFullWages: false }, pt: { stateCode: null, category: 'GENERAL' }, leaves: '2026-12' });

  it('spreads the tax over the months to the leaving date, and settles it exactly', () => {
    expect(slips).toHaveLength(9);
    // From April, 9 months are expected: 1,50,800 / 9 = 16,756 a month.
    expect(slips[0].r.tds.amount).toBe('16756.00');
    // 9 x 2,00,000 = 18,00,000; taxable 17,25,000: 1,20,000 + 1,25,000 x 20% = 1,45,000; cess 5,800.
    const last = slips[8].r;
    expect(last.tds.projectedIncome).toBe('1800000.00');
    expect(last.tds.annualTax).toBe('150800.00');
    expect(sum(slips, (r) => r.tds.amount)).toBe('150800.00');
  });

  it('never deducts negative tax when earlier months took more than the year needs', () => {
    // A cut to Rs 20,000 from October leaves the year within the rebate after months at the full rate.
    const cut = runYear({
      salary: (p) => [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: p >= '2026-10' ? '20000' : '150000' }],
      pf: { member: false, eps: false, onFullWages: false },
      pt: { stateCode: null, category: 'GENERAL' },
    });
    for (const s of cut) {
      checkIdentities(s.r);
      expect(dec(s.r.tds.amount).gte(0)).toBe(true);
    }
    // 6 x 1,50,000 + 6 x 20,000 = 10,20,000: no tax for the year, so nothing after September.
    expect(cut[11].r.tds.annualTax).toBe('0.00');
    expect(cut.slice(6).every((s) => s.r.tds.amount === '0.00')).toBe(true);
  });
});

describe('payslips across tax years', () => {
  it('uses each year\'s rules when a run spans March and April', () => {
    const salary = (): PayComponentInput[] => [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '90000' }];
    const e: Employee = { salary, pf: { member: false, eps: false, onFullWages: false }, pt: { stateCode: null, category: 'GENERAL' } };
    const y25 = runYear(e, ['2024-04', '2024-05', '2024-06', '2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03']);
    // 10,80,000 − 75,000 = 10,05,000 in 2024-25: 20,000 + 30,000 + 750 = 50,750; cess 2,030.
    expect(sum(y25, (r) => r.tds.amount)).toBe('52780.00');
    // The same pay in 2025-26 is within the Rs 12 lakh rebate.
    const y26 = runYear(e, ['2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
    expect(sum(y26, (r) => r.tds.amount)).toBe('0.00');
  });
});
