import { D } from '@talk2tax/accounting-engine';
import { describe, expect, it } from 'vitest';
import {
  codeWages,
  computePayslip,
  esiContributionPeriodStart,
  monthsLeftInTaxYear,
  newRegimeTax,
  payrollDueDates,
  pfContributions,
  pfCeilingSegments,
  PayslipInput,
  professionalTax,
  taxYearLabel,
} from '../src';

const tax = (v: string) => newRegimeTax(new D(v)).toFixed(0);

describe('new tax regime, tax year 2026-27', () => {
  it('is nil up to Rs 12 lakh because of the rebate', () => {
    expect(tax('0')).toBe('0');
    expect(tax('400000')).toBe('0');
    expect(tax('1200000')).toBe('0');
  });
  it('gives marginal relief just above Rs 12 lakh (tax is limited to the income above it)', () => {
    // Slab tax 61,500 is cut to 10,000; plus 4% cess.
    expect(tax('1210000')).toBe('10400');
    // 75,000 is below the 1,00,000 above the limit, so no relief.
    expect(tax('1300000')).toBe('78000');
  });
  it('applies the slabs and cess', () => {
    expect(tax('1600000')).toBe('124800');
    expect(tax('2400000')).toBe('312000');
    expect(tax('3000000')).toBe('499200');
  });
  it('adds surcharge above Rs 50 lakh with marginal relief', () => {
    // 11,10,000 + 10% would be 12,21,000; limited to 10,80,000 at 50 lakh plus the 1,00,000 above it.
    expect(tax('5100000')).toBe('1227200');
  });
  it('rounds to the nearest Rs 10', () => {
    // 20,000 + 40,000 + 15% of 1,23,457 = 78,518.55; cess 4% = 81,659.29.
    expect(tax('1323457')).toBe('81660');
  });
});

describe('wages under the Code on Social Security 2020', () => {
  it('leaves excluded allowances out while they are at most half of the pay', () => {
    const r = codeWages([{ kind: 'WAGES', amount: new D(30000) }, { kind: 'EXCLUDED', amount: new D(15000) }, { kind: 'WAGES', amount: new D(10000) }]);
    expect(r.wages.toFixed(2)).toBe('40000.00');
    expect(r.addedBack.toFixed(2)).toBe('0.00');
  });
  it('adds back the excess over half of total remuneration', () => {
    const r = codeWages([{ kind: 'WAGES', amount: new D(10000) }, { kind: 'EXCLUDED', amount: new D(15000) }]);
    expect(r.wages.toFixed(2)).toBe('12500.00');
    expect(r.addedBack.toFixed(2)).toBe('2500.00');
  });
});

describe('EPF', () => {
  const member = { member: true, eps: true, onFullWages: false };
  it('caps at Rs 15,000 before 17 September 2026', () => {
    const r = pfContributions('2026-08', new D(40000), member);
    expect([r.wages, r.employee, r.eps, r.epfEmployer, r.edli, r.admin].map((x) => x.toFixed(0))).toEqual(['15000', '1800', '1250', '550', '75', '75']);
  });
  it('caps at Rs 25,000 from 17 September 2026', () => {
    const r = pfContributions('2026-10', new D(40000), member);
    expect([r.wages, r.employee, r.eps, r.epfEmployer, r.edli, r.admin].map((x) => x.toFixed(0))).toEqual(['25000', '3000', '2083', '917', '125', '125']);
  });
  it('apportions September 2026 between the two ceilings by days', () => {
    expect(pfCeilingSegments('2026-09').map((s) => [s.days, s.ceiling.toFixed()])).toEqual([[16, '15000'], [14, '25000']]);
    // 16/30 of 30,000 = 16,000 capped at 8,000; 14/30 = 14,000 capped at 11,666.67.
    const r = pfContributions('2026-09', new D(30000), member);
    expect(r.wages.toFixed(0)).toBe('19667');
    expect(r.employee.toFixed(0)).toBe('2360');
    expect(r.eps.toFixed(0)).toBe('1638');
  });
  it('contributes on full wages when the employee and employer agreed to, with EPS still capped', () => {
    const r = pfContributions('2026-10', new D(40000), { member: true, eps: true, onFullWages: true });
    expect([r.wages, r.employee, r.eps, r.epfEmployer, r.edli, r.admin].map((x) => x.toFixed(0))).toEqual(['40000', '4800', '2083', '2717', '125', '200']);
  });
  it('puts the whole employer share in EPF for a member without EPS', () => {
    const r = pfContributions('2026-10', new D(20000), { member: true, eps: false, onFullWages: false });
    expect([r.eps, r.epfEmployer].map((x) => x.toFixed(0))).toEqual(['0', '2400']);
  });
  it('is nothing for a non-member', () => {
    expect(pfContributions('2026-10', new D(20000), { member: false, eps: false, onFullWages: false }).employee.toFixed(0)).toBe('0');
  });
});

describe('professional tax (Maharashtra)', () => {
  it('follows the slabs, with Rs 300 in February', () => {
    expect(professionalTax('2026-10', new D(7500), '27', 'GENERAL').amount.toFixed(0)).toBe('0');
    expect(professionalTax('2026-10', new D(9000), '27', 'GENERAL').amount.toFixed(0)).toBe('175');
    expect(professionalTax('2026-10', new D(10001), '27', 'GENERAL').amount.toFixed(0)).toBe('200');
    expect(professionalTax('2027-02', new D(50000), '27', 'GENERAL').amount.toFixed(0)).toBe('300');
  });
  it('exempts women up to Rs 25,000 and those exempt under the Act', () => {
    expect(professionalTax('2026-10', new D(25000), '27', 'WOMAN').amount.toFixed(0)).toBe('0');
    expect(professionalTax('2026-10', new D(25001), '27', 'WOMAN').amount.toFixed(0)).toBe('200');
    expect(professionalTax('2026-10', new D(90000), '27', 'EXEMPT').amount.toFixed(0)).toBe('0');
  });
  it('says so for states not built yet', () => {
    expect(professionalTax('2026-10', new D(90000), '29', 'GENERAL').note).toMatch(/not built/);
  });
});

describe('calendar helpers', () => {
  it('finds the ESI contribution period, months left and the tax year', () => {
    expect(['2026-04', '2026-09', '2026-10', '2027-02'].map(esiContributionPeriodStart)).toEqual(['2026-04', '2026-04', '2026-10', '2026-10']);
    expect(['2026-04', '2026-10', '2027-03'].map(monthsLeftInTaxYear)).toEqual([12, 6, 1]);
    expect(taxYearLabel('2027-03')).toBe('2026-27');
  });
  it('gives due dates', () => {
    expect(payrollDueDates('2026-10')).toEqual({ PF: '2026-11-15', ESI: '2026-11-15', TDS: '2026-11-07', PT: '2026-11-30' });
    expect(payrollDueDates('2027-03').TDS).toBe('2027-04-30');
    expect(payrollDueDates('2026-12').PF).toBe('2027-01-15');
  });
});

const base = (over: Partial<PayslipInput> = {}): PayslipInput => ({
  period: '2026-10',
  paidDays: '31',
  components: [
    { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '60000' },
    { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthly: '30000' },
    { code: 'SPECIAL', name: 'Special allowance', kind: 'WAGES', monthly: '20000' },
  ],
  pf: { member: true, eps: true, onFullWages: false },
  esiCoveredForPeriod: null,
  pt: { stateCode: '27', category: 'GENERAL' },
  tax: { incomeBefore: '660000', tdsBefore: '23400', futureMonths: 5 },
  ...over,
});

describe('payslip', () => {
  it('works out a full month', () => {
    // Annual 13.2 lakh, taxable 12.45 lakh: slab tax 66,750 limited to 45,000 by marginal relief, plus cess = 46,800 (3,900 a month).
    const r = computePayslip(base());
    expect(r.gross).toBe('110000.00');
    expect(r.wages).toBe('80000.00');
    expect(r.pf).toEqual({ wages: '25000.00', employee: '3000.00', eps: '2083.00', epfEmployer: '917.00', edli: '125.00', admin: '125.00' });
    expect(r.esi).toEqual({ covered: false, wages: '0.00', employee: '0.00', employer: '0.00' });
    expect(r.pt.amount).toBe('200.00');
    expect(r.tds.annualTax).toBe('46800.00');
    expect(r.tds.amount).toBe('3900.00');
    expect(r.deductions).toBe('7100.00');
    expect(r.net).toBe('102900.00');
    expect(r.employerCost).toBe('113250.00');
  });

  it('pro-rates for loss of pay and keeps ESI coverage for the contribution period', () => {
    const r = computePayslip(
      base({
        period: '2026-11',
        paidDays: '15',
        components: [
          { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '10000' },
          { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthly: '15000' },
        ],
        esiCoveredForPeriod: true,
        tax: { incomeBefore: '0', tdsBefore: '0', futureMonths: 4 },
      }),
    );
    expect(r.earnings.map((e) => e.amount)).toEqual(['5000.00', '7500.00']);
    expect(r.gross).toBe('12500.00');
    expect(r.wages).toBe('6250.00');
    expect(r.wagesAddedBack).toBe('1250.00');
    expect(r.pf.employee).toBe('750.00');
    // ESI rounds up to the rupee: 0.75% of 6,250 = 46.875; 3.25% = 203.125.
    expect(r.esi).toEqual({ covered: true, wages: '6250.00', employee: '47.00', employer: '204.00' });
    expect(r.pt.amount).toBe('200.00');
    expect(r.tds.amount).toBe('0.00');
    expect(r.net).toBe('11503.00');
  });

  it('decides ESI coverage on full-month wages in the first month of a period', () => {
    const r = computePayslip(base({ components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '21000' }], tax: { incomeBefore: '0', tdsBefore: '0', futureMonths: 5 } }));
    expect(r.esi.covered).toBe(true);
    expect(r.esi.employee).toBe('158.00');
  });

  it('adds one-off earnings and taxes them in the year', () => {
    const r = computePayslip(base({ oneOffs: [{ name: 'Diwali bonus', kind: 'EXCLUDED', amount: '50000' }] }));
    expect(r.gross).toBe('160000.00');
    // Excluded items 80,000 are not above half of 1,60,000, so wages stay at 80,000.
    expect(r.wages).toBe('80000.00');
    // Taxable 12.95 lakh: slab tax 74,250 (below the 95,000 above the limit) plus cess = 77,220. (77,220 − 23,400) / 6 = 8,970.
    expect(r.tds.annualTax).toBe('77220.00');
    expect(r.tds.amount).toBe('8970.00');
  });

  it('takes the rest of the tax in the last month', () => {
    const r = computePayslip(base({ tax: { incomeBefore: '660000', tdsBefore: '0', futureMonths: 0 } }));
    // Only 7.7 lakh projected (leaving this month), taxable 6.95 lakh: within the rebate.
    expect(r.tds.amount).toBe('0.00');
  });

  it('deducts at least 20% of the month\'s taxable salary without a PAN', () => {
    const r = computePayslip(base({ tax: { incomeBefore: '660000', tdsBefore: '23400', futureMonths: 5, hasPan: false } }));
    // 20% of (1,10,000 − 6,250) = 20,750, above the 3,900 the projection gives.
    expect(r.tds.amount).toBe('20750.00');
    expect(r.tds.note).toMatch(/No PAN/);
    // Nothing when there is no tax for the year anyway.
    const low = computePayslip(base({ components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly: '30000' }], tax: { incomeBefore: '0', tdsBefore: '0', futureMonths: 11, hasPan: false } }));
    expect(low.tds.amount).toBe('0.00');
  });

  it('refuses impossible paid days', () => {
    expect(() => computePayslip(base({ paidDays: '32' }))).toThrow(/between 0 and 31/);
    expect(() => computePayslip(base({ paidDays: '10.3' }))).toThrow(/half days/);
  });
});
