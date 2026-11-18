import { describe, expect, it } from 'vitest';
import { advanceTaxInstalments, corporateTax, projectedIncome } from '../src';

const t = (income: string, regime: Parameters<typeof corporateTax>[1]) => {
  const r = corporateTax(income, regime);
  return { tax: r.tax.toFixed(), surcharge: r.surcharge.toFixed(), relief: r.marginalRelief.toFixed(), cess: r.cess.toFixed(), total: r.total.toFixed() };
};

describe('tax on the year', () => {
  it('applies the concessional company rate with its flat surcharge and cess', () => {
    expect(t('1000000', 'COMPANY_22')).toEqual({ tax: '220000', surcharge: '22000', relief: '0', cess: '9680', total: '251680' });
  });

  it('has no surcharge below ₹1 crore for a firm', () => {
    expect(t('5000000', 'FIRM_30')).toEqual({ tax: '1500000', surcharge: '0', relief: '0', cess: '60000', total: '1560000' });
  });

  it('gives marginal relief just above ₹1 crore', () => {
    // Without relief the surcharge would be 2,10,210; tax and surcharge cannot exceed 30,00,000 + 10,000.
    expect(t('10010000', 'COMPANY_30')).toEqual({ tax: '3003000', surcharge: '210210', relief: '203210', cess: '120400', total: '3130400' });
  });

  it('gives marginal relief just above ₹10 crore against the 7% band', () => {
    expect(t('100500000', 'COMPANY_25')).toEqual({ tax: '25125000', surcharge: '3015000', relief: '890000', cess: '1090000', total: '28340000' });
  });

  it('rounds income and tax to tens and treats a loss as nil', () => {
    expect(corporateTax('1004', 'FIRM_30').income.toFixed()).toBe('1000');
    expect(t('-50000', 'COMPANY_25').total).toBe('0');
  });
});

describe('income for the year', () => {
  it('annualises the profit so far by days, or takes the estimate', () => {
    const base = { from: '2026-04-01', to: '2027-03-31', profitToDate: '1000000' };
    expect(projectedIncome({ ...base, asOf: '2026-09-30', method: 'ANNUALISE' })).toMatchObject({ daysElapsed: 183, daysInYear: 365 });
    expect(projectedIncome({ ...base, asOf: '2026-09-30', method: 'ANNUALISE' }).amount.toFixed(2)).toBe('1994535.52');
    expect(projectedIncome({ ...base, asOf: '2027-05-01', method: 'ANNUALISE' }).amount.toFixed()).toBe('1000000');
    expect(projectedIncome({ ...base, asOf: '2026-03-01', method: 'ANNUALISE' }).amount.toFixed()).toBe('0');
    expect(projectedIncome({ ...base, asOf: '2026-09-30', method: 'ESTIMATE', estimate: '2500000' }).amount.toFixed()).toBe('2500000');
  });
});

describe('instalments', () => {
  it('shows what was due and paid by each date, and what is left to pay', () => {
    const r = advanceTaxInstalments('2026-04-01', '100000', [{ date: '2026-06-10', amount: '15000' }, { date: '2026-09-20', amount: '30000' }], '2026-11-18');
    expect(r.map((i) => [i.dueDate, i.required.toFixed(), i.paidByDue.toFixed(), i.status, i.toPay.toFixed()])).toEqual([
      ['2026-06-15', '15000', '15000', 'PAID', '0'],
      ['2026-09-15', '45000', '15000', 'SHORT', '30000'],
      ['2026-12-15', '75000', '45000', 'UPCOMING', '30000'],
      ['2027-03-15', '100000', '45000', 'UPCOMING', '55000'],
    ]);
  });
});
