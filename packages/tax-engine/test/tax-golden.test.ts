import { D, dec } from '@talk2tax/accounting-engine';
import { describe, expect, it } from 'vitest';
import {
  computePayslip,
  computeWithholding,
  corporateTax,
  gstComponents,
  NEW_REGIME_2024_25,
  NEW_REGIME_2025_26,
  NEW_REGIME_2026_27,
  NEW_REGIME_RULES,
  newRegimeRulesFor,
  newRegimeTax,
  NewRegimeRules,
  PayslipInput,
  TDS_TEMPLATES,
  WithholdingRule,
} from '../src';

/**
 * Tax calculation tests (QA-007) and effective-dated rules (QA-029).
 *
 * Golden values are worked out by hand from the slabs and rates in force for each tax year, not
 * from the code under test, so a change to a rule table or a calculation shows up here. The
 * invariant checks sweep whole ranges of income: tax never goes down as income goes up, and never
 * takes more than the extra income across a threshold (marginal relief).
 */

const tax = (income: string, rules: NewRegimeRules = NEW_REGIME_2026_27) => newRegimeTax(new D(income), rules).toFixed(0);

describe('income tax golden values by tax year (new regime)', () => {
  it('2024-25: slabs 3/7/10/12/15 lakh, rebate up to Rs 25,000 on income to Rs 7 lakh', () => {
    const r = NEW_REGIME_2024_25;
    expect(tax('300000', r)).toBe('0');
    expect(tax('700000', r)).toBe('0'); // 20,000 slab tax, fully rebated
    expect(tax('710000', r)).toBe('10400'); // slab tax 21,000; relief limits it to the 10,000 above 7 lakh; cess 400
    expect(tax('1000000', r)).toBe('52000'); // 20,000 + 30,000 = 50,000; cess 2,000
    expect(tax('1200000', r)).toBe('83200'); // 50,000 + 30,000 = 80,000; cess 3,200
    expect(tax('1500000', r)).toBe('145600'); // 80,000 + 60,000 = 1,40,000; cess 5,600
    expect(tax('2000000', r)).toBe('301600'); // 1,40,000 + 1,50,000 = 2,90,000; cess 11,600
  });

  it('2025-26: slabs 4/8/12/16/20/24 lakh, rebate up to Rs 60,000 on income to Rs 12 lakh', () => {
    const r = NEW_REGIME_2025_26;
    expect(tax('700000', r)).toBe('0');
    expect(tax('1200000', r)).toBe('0'); // 60,000 slab tax, fully rebated
    expect(tax('1210000', r)).toBe('10400'); // slab tax 61,500; relief to 10,000; cess 400
    expect(tax('1600000', r)).toBe('124800'); // 20,000 + 40,000 + 60,000 = 1,20,000; cess 4,800
    expect(tax('2400000', r)).toBe('312000'); // 1,20,000 + 80,000 + 1,00,000 = 3,00,000; cess 12,000
    expect(tax('3000000', r)).toBe('499200'); // 3,00,000 + 1,80,000 = 4,80,000; cess 19,200
  });

  it('2026-27 keeps the 2025-26 rates', () => {
    for (const income of ['0', '400000', '1200000', '1210000', '1600000', '2400000', '3000000', '6000000']) {
      expect(tax(income, NEW_REGIME_2026_27)).toBe(tax(income, NEW_REGIME_2025_26));
    }
  });

  it('the same income is taxed differently in different years', () => {
    // Rs 10 lakh: 52,000 in 2024-25, nil from 2025-26 because of the larger rebate.
    expect(tax('1000000', NEW_REGIME_2024_25)).toBe('52000');
    expect(tax('1000000', NEW_REGIME_2025_26)).toBe('0');
  });

  it('adds surcharge above Rs 50 lakh, 1 crore and 2 crore, with marginal relief at each step', () => {
    const r = NEW_REGIME_2026_27;
    // At 50 lakh: slab tax 3,00,000 + 26 lakh at 30% = 10,80,000; cess 43,200.
    expect(tax('5000000', r)).toBe('1123200');
    // At 1 crore: 25,80,000 tax + 10% = 28,38,000; cess 1,13,520.
    expect(tax('10000000', r)).toBe('2951520');
    // At 2 crore: 55,80,000 + 15% = 64,17,000; cess 2,56,680.
    expect(tax('20000000', r)).toBe('6673680');
    // At 3 crore: 85,80,000 + 25% = 1,07,25,000; cess 4,29,000.
    expect(tax('30000000', r)).toBe('11154000');
  });

  it('never decreases as income rises, and never takes more than the extra income across a threshold', () => {
    for (const rules of NEW_REGIME_RULES) {
      const points = new Set<number>();
      for (let x = 0; x <= 31_000_000; x += 25_000) points.add(x);
      // Close to each threshold, where marginal relief applies.
      for (const t of [rules.rebateIncomeLimit, ...rules.surcharge.map((s) => s.above)]) {
        for (const d of [-1000, -10, 0, 1, 10, 100, 1000, 5000, 20000, 50000, 100000]) points.add(Number(t) + d);
      }
      const sorted = [...points].filter((x) => x >= 0).sort((a, b) => a - b);
      let prev = { income: 0, tax: new D(0) };
      for (const x of sorted) {
        const t = newRegimeTax(new D(x), rules);
        expect(t.gte(prev.tax), `${rules.taxYear}: tax at ${x} below tax at ${prev.income}`).toBe(true);
        // Rounding to the nearest Rs 10 can add at most Rs 10 on top of the income gained, plus cess on it.
        const extra = new D(x - prev.income).times('1.04').plus(10);
        expect(t.minus(prev.tax).lte(extra), `${rules.taxYear}: tax rose by more than the income between ${prev.income} and ${x}`).toBe(true);
        prev = { income: x, tax: t };
      }
    }
  });
});

describe('effective-dated income tax rules (QA-029)', () => {
  it('finds the rules for each tax year built', () => {
    expect(NEW_REGIME_RULES.map((r) => r.taxYear)).toEqual(['2024-25', '2025-26', '2026-27']);
    expect(newRegimeRulesFor('2024-25')).toEqual({ rules: NEW_REGIME_2024_25, exact: true });
    expect(newRegimeRulesFor('2025-26').rules).toBe(NEW_REGIME_2025_26);
    expect(newRegimeRulesFor('2026-27').rules).toBe(NEW_REGIME_2026_27);
  });

  it('uses the latest rules for a later year and says so, and refuses an earlier year or a bad label', () => {
    expect(newRegimeRulesFor('2027-28')).toEqual({ rules: NEW_REGIME_2026_27, exact: false });
    expect(() => newRegimeRulesFor('2023-24')).toThrow(/rules for 2023-24 are not built \(the earliest is 2024-25\)/);
    expect(() => newRegimeRulesFor('FY24')).toThrow(/Not a tax year/);
  });

  const slip = (period: string, monthly: string, months: { before: number; future: number }): PayslipInput => ({
    period,
    paidDays: String(new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()),
    components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthly }],
    pf: { member: false, eps: false, onFullWages: false },
    esiCoveredForPeriod: false,
    pt: { stateCode: null, category: 'GENERAL' },
    tax: { incomeBefore: dec(monthly).times(months.before).toFixed(2), tdsBefore: '0', futureMonths: months.future, hasPan: true },
  });

  it('taxes a payslip by the tax year of its month, not by today', () => {
    // Rs 80,000 a month: 9,60,000 a year, 8,85,000 after the standard deduction.
    // March 2025 (2024-25): 20,000 + 18,500 = 38,500; cess 1,540; all of it in the last month.
    const march25 = computePayslip(slip('2025-03', '80000', { before: 11, future: 0 }));
    expect(march25.tds).toMatchObject({ taxableIncome: '885000.00', annualTax: '40040.00', amount: '40040.00' });
    expect(march25.tds.note).toMatch(/for 2024-25/);
    // April 2025 (2025-26) and April 2026 (2026-27): within the Rs 12 lakh rebate.
    for (const period of ['2025-04', '2026-04']) {
      const r = computePayslip(slip(period, '80000', { before: 0, future: 11 }));
      expect(r.tds).toMatchObject({ annualTax: '0.00', amount: '0.00' });
      expect(r.tds.note).toMatch(/within the rebate/);
    }
  });

  it('spreads the year\'s tax under that year\'s rules', () => {
    // Rs 1,50,000 a month from April: 18,00,000 a year, 17,25,000 taxable.
    // 2024-25: 1,40,000 + 2,25,000 x 30% = 2,07,500; cess 8,300 = 2,15,800, over 12 months = 17,983.
    const y24 = computePayslip(slip('2024-04', '150000', { before: 0, future: 11 }));
    expect(y24.tds).toMatchObject({ annualTax: '215800.00', amount: '17983.00' });
    // 2026-27: 1,20,000 + 1,25,000 x 20% = 1,45,000; cess 5,800 = 1,50,800, over 12 months = 12,567.
    const y26 = computePayslip(slip('2026-04', '150000', { before: 0, future: 11 }));
    expect(y26.tds).toMatchObject({ annualTax: '150800.00', amount: '12567.00' });
  });

  it('says when a month is past the last year built, and refuses one before the first', () => {
    const later = computePayslip(slip('2027-04', '150000', { before: 0, future: 11 }));
    expect(later.tds.annualTax).toBe('150800.00');
    expect(later.tds.note).toMatch(/The rates for 2027-28 are not built yet, so the 2026-27 rates were used/);
    expect(() => computePayslip(slip('2024-03', '80000', { before: 11, future: 0 }))).toThrow(/2023-24 are not built/);
  });
});

describe('GST golden values', () => {
  const accounts = { cgst: 'cgst', sgst: 'sgst', igst: 'igst' };
  const split = (net: string, rate: string, nature: 'INTRA' | 'INTER') =>
    gstComponents(dec(net), dec(rate), 'TAXABLE', { nature, stateCode: '27', accounts }, 'INR').map((c) => `${c.code} ${c.amount.toFixed(2)}`);

  it('charges each standard rate on intra- and inter-state supplies', () => {
    expect(split('10000', '5', 'INTRA')).toEqual(['CGST 250.00', 'SGST 250.00']);
    expect(split('10000', '5', 'INTER')).toEqual(['IGST 500.00']);
    expect(split('10000', '18', 'INTRA')).toEqual(['CGST 900.00', 'SGST 900.00']);
    expect(split('10000', '18', 'INTER')).toEqual(['IGST 1800.00']);
    expect(split('10000', '40', 'INTRA')).toEqual(['CGST 2000.00', 'SGST 2000.00']);
    expect(split('10000', '3', 'INTER')).toEqual(['IGST 300.00']);
    expect(split('10000', '0.25', 'INTRA')).toEqual(['CGST 12.50', 'SGST 12.50']);
    expect(split('99.99', '18', 'INTER')).toEqual(['IGST 18.00']);
  });

  it('keeps CGST and SGST within a paisa of IGST on the same amount', () => {
    for (let paise = 1; paise <= 200_000; paise += 997) {
      const net = (paise / 100).toFixed(2);
      for (const rate of ['0.25', '3', '5', '12', '18', '28', '40']) {
        const intra = gstComponents(dec(net), dec(rate), 'TAXABLE', { nature: 'INTRA', stateCode: '27', accounts }, 'INR');
        const inter = gstComponents(dec(net), dec(rate), 'TAXABLE', { nature: 'INTER', stateCode: '27', accounts }, 'INR');
        expect(intra[0].amount.eq(intra[1].amount)).toBe(true);
        const diff = intra[0].amount.plus(intra[1].amount).minus(inter[0].amount).abs();
        expect(diff.lte('0.01'), `${net} at ${rate}%`).toBe(true);
      }
    }
  });
});

describe('TDS golden values', () => {
  const rule = (code: string): WithholdingRule => {
    const t = TDS_TEMPLATES.find((x) => x.code === code)!;
    return { ...t, kind: 'TDS' };
  };
  const company = 'AAACC1234F';
  const person = 'ABCPK1234F';
  const none = { aggregateBefore: '0', taxedBefore: '0' };

  it('deducts on contractors at 1% for individuals and 2% for others, above Rs 30,000 a bill', () => {
    const c = rule('393(1)-6(i)');
    expect(computeWithholding(c, '30000', none, person).amount).toBe('0.00');
    expect(computeWithholding(c, '30000.01', none, person).amount).toBe('300.00');
    expect(computeWithholding(c, '50000', none, company).amount).toBe('1000.00');
    // The year's total passes Rs 1 lakh: earlier small bills are caught up.
    expect(computeWithholding(c, '25000', { aggregateBefore: '80000', taxedBefore: '0' }, company)).toMatchObject({ base: '105000.00', amount: '2100.00' });
  });

  it('deducts 10% on professional fees above Rs 50,000 a year, and 20% without a PAN', () => {
    const p = rule('393(1)-6(iii)(b)');
    expect(computeWithholding(p, '50000', none, company).amount).toBe('0.00');
    expect(computeWithholding(p, '60000', none, company).amount).toBe('6000.00');
    expect(computeWithholding(p, '60000', none, null).amount).toBe('12000.00');
  });

  it('deducts 0.1% only on purchases above Rs 50 lakh', () => {
    const g = rule('393(1)-8(ii)');
    expect(computeWithholding(g, '1000000', { aggregateBefore: '4500000', taxedBefore: '0' }, company)).toMatchObject({ base: '500000.00', amount: '500.00' });
    expect(computeWithholding(g, '1000000', { aggregateBefore: '5500000', taxedBefore: '500000' }, company)).toMatchObject({ base: '1000000.00', amount: '1000.00' });
  });

  it('dates every section from the day the Income-tax Act 2025 applies', () => {
    for (const t of TDS_TEMPLATES) expect(t.validFrom, t.code).toBe('2026-04-01');
  });
});

describe('corporate tax golden values', () => {
  it('works out tax, surcharge and cess for each regime', () => {
    // 22% + 10% surcharge + 4% cess on Rs 1 crore: 22,00,000 + 2,20,000 = 24,20,000; cess 96,800.
    expect(corporateTax('10000000', 'COMPANY_22').total.toFixed(0)).toBe('2516800');
    // 25% on Rs 50 lakh, no surcharge: 12,50,000; cess 50,000.
    expect(corporateTax('5000000', 'COMPANY_25').total.toFixed(0)).toBe('1300000');
    // Firm at 30% on Rs 2 crore with 12% surcharge: 60,00,000 + 7,20,000; cess 2,68,800.
    expect(corporateTax('20000000', 'FIRM_30').total.toFixed(0)).toBe('6988800');
  });

  it('never decreases as income rises', () => {
    for (const regime of ['COMPANY_22', 'COMPANY_25', 'COMPANY_30', 'FIRM_30'] as const) {
      let prev = new D(0);
      for (let x = 0; x <= 120_000_000; x += 250_000) {
        const t = corporateTax(String(x), regime).total;
        expect(t.gte(prev), `${regime} at ${x}`).toBe(true);
        prev = t;
      }
    }
  });
});
