import { describe, expect, it } from 'vitest';
import { incomeComputation } from '../src';

const base = {
  profitBeforeTax: '1000000',
  taxInBooks: '250000',
  bookDepreciation: '120000',
  taxDepreciation: '150000',
  cashDisallowance: '25000',
  adjustments: [
    { label: 'Donations not deductible', section: '37(1)', kind: 'ADD' as const, amount: '10000' },
    { label: 'Leave encashment paid, provided last year', section: '43B', kind: 'DEDUCT' as const, amount: '5000' },
  ],
  broughtForwardLoss: '200000',
  regime: 'COMPANY_22' as const,
  credits: { tds: '20000', advanceTax: '100000', other: '0' },
};

describe('income tax computation', () => {
  it('adjusts book profit, sets off the brought forward loss and works out the tax due', () => {
    const r = incomeComputation(base);
    expect(r.lines.map((l) => [l.kind, l.section, l.amount])).toEqual([
      ['START', null, '1000000.00'],
      ['ADD', '32', '120000.00'],
      ['DEDUCT', '32', '150000.00'],
      ['ADD', '40A(3)', '25000.00'],
      ['ADD', '37(1)', '10000.00'],
      ['DEDUCT', '43B', '5000.00'],
    ]);
    expect(r).toMatchObject({ businessIncome: '1000000.00', lossSetOff: '200000.00', totalIncome: '800000.00', roundedIncome: '800000.00', lossCarriedForward: '0.00', warnings: [] });
    // 22% with 10% surcharge and 4% cess: 800000 × 0.22 = 176000; surcharge 17600; cess 7744.
    expect(r.tax).toEqual({ tax: '176000.00', surchargeRate: '10', surcharge: '17600.00', marginalRelief: '0.00', cess: '7744.00', total: '201340.00' });
    expect(r.credits.total).toBe('120000.00');
    expect(r).toMatchObject({ payable: '81340.00', refund: '0.00' });
  });

  it('carries a loss forward and refunds the tax paid', () => {
    const r = incomeComputation({ ...base, profitBeforeTax: '-300000', taxDepreciation: null, adjustments: [] });
    expect(r).toMatchObject({ businessIncome: '-155000.00', lossSetOff: '0.00', totalIncome: '0.00', lossCarriedForward: '355000.00', payable: '0.00', refund: '120000.00' });
    expect(r.tax.total).toBe('0.00');
    expect(r.warnings).toEqual([
      'Enter the depreciation allowed under section 32 from the block-of-assets working; until then none is deducted.',
      'There is a loss this year: no tax is due, and the loss is carried forward if the return is filed on time (section 80).',
    ]);
  });

  it('sets off only up to the income and rounds income to the nearest 10', () => {
    const r = incomeComputation({ ...base, profitBeforeTax: '100004', bookDepreciation: '0', taxDepreciation: null, cashDisallowance: '0', adjustments: [], broughtForwardLoss: '0', credits: { tds: '0', advanceTax: '0', other: '0' } });
    expect(r.lines).toHaveLength(1);
    expect(r).toMatchObject({ totalIncome: '100004.00', roundedIncome: '100000.00', warnings: [] });
    const s = incomeComputation({ ...base, profitBeforeTax: '50000', bookDepreciation: '0', taxDepreciation: null, cashDisallowance: '0', adjustments: [] });
    expect(s).toMatchObject({ lossSetOff: '50000.00', totalIncome: '0.00', lossCarriedForward: '150000.00' });
  });
});
