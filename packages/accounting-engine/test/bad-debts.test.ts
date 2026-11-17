import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVISION_RATES, provisionAdjustment, provisionMatrix, rateIssues, writeOffIssues } from '../src/bad-debts';

describe('provision matrix', () => {
  it('applies each bucket rate once per bucket, and specific percentages per invoice', () => {
    const r = provisionMatrix(
      [
        { bucket: 'current', open: '100000.00' },
        { bucket: 'current', open: '33333.33' },
        { bucket: 'days31to60', open: '50000' },
        { bucket: 'over90', open: '40000' },
        { bucket: 'over90', open: '25000', specificPercent: '100' },
        { bucket: 'days1to30', open: '0' },
      ],
      DEFAULT_PROVISION_RATES,
      'INR',
    );
    expect(r.buckets.map((b) => [b.bucket, b.open, b.provision, b.invoices])).toEqual([
      ['current', '133333.33', '1333.33', 2],
      ['days1to30', '0.00', '0.00', 0],
      ['days31to60', '50000.00', '5000.00', 1],
      ['days61to90', '0.00', '0.00', 0],
      ['over90', '40000.00', '20000.00', 1],
    ]);
    expect(r.specific).toEqual({ open: '25000.00', provision: '25000.00', invoices: 1 });
    expect(r.open).toBe('248333.33');
    expect(r.total).toBe('51333.33');
  });

  it('works in currencies without minor units, and posts only the difference', () => {
    expect(provisionMatrix([{ bucket: 'over90', open: '1001' }], { ...DEFAULT_PROVISION_RATES, over90: '50' }, 'JPY').total).toBe('500');
    expect(provisionAdjustment('51333.33', '40000', 'INR')).toBe('11333.33');
    expect(provisionAdjustment('30000', '40000.00', 'INR')).toBe('-10000.00');
  });

  it('checks the percentages', () => {
    expect(rateIssues({ current: '1', over90: '100' })).toEqual([]);
    expect(rateIssues({ current: '101', over90: '-1', x: '1.23456' })).toHaveLength(3);
  });
});

describe('write-offs', () => {
  it('needs an amount above zero, within what is still due, in the currency precision', () => {
    expect(writeOffIssues('500.00', '500', 'INR')).toEqual([]);
    expect(writeOffIssues('0', '500', 'INR')[0]).toMatch(/greater than zero/);
    expect(writeOffIssues('500.01', '500', 'INR')).toEqual(['Only 500.00 INR is still due on this invoice']);
    expect(writeOffIssues('1.001', '5', 'INR')[0]).toMatch(/decimal/);
    expect(writeOffIssues('abc', '5', 'INR')).toEqual(['The amount is not a number']);
  });
});
