import { describe, expect, it } from 'vitest';
import { checkDimensionCode, profitByDimension, type DimensionActivity } from '../src';

const values = [
  { id: 'd-sales', code: 'SALES', name: 'Sales' },
  { id: 'd-ops', code: 'OPS', name: 'Operations' },
  { id: 'd-hr', code: 'HR', name: 'People' },
];
const act = (accountId: string, code: string, type: 'REVENUE' | 'EXPENSE', valueId: string | null, debit: string, credit: string): DimensionActivity => ({ accountId, code, name: code, type, valueId, debit, credit });

describe('financial dimensions', () => {
  it('checks codes', () => {
    expect(checkDimensionCode('SALES-N')).toBeNull();
    expect(checkDimensionCode('P_2026_01')).toBeNull();
    expect(checkDimensionCode('-X')).not.toBeNull();
    expect(checkDimensionCode('has space')).not.toBeNull();
    expect(checkDimensionCode('A'.repeat(21))).not.toBeNull();
  });

  it('splits the profit and loss by value, with what is not assigned in its own column', () => {
    const r = profitByDimension(values, [
      act('rev', '4100', 'REVENUE', 'd-sales', '0', '100000.00'),
      act('rev', '4100', 'REVENUE', 'd-sales', '5000.00', '0'),
      act('rev', '4100', 'REVENUE', null, '0', '20000.00'),
      act('rent', '6200', 'EXPENSE', 'd-ops', '30000.00', '0'),
      act('sal', '6100', 'EXPENSE', 'd-sales', '40000.00', '0'),
      act('sal', '6100', 'EXPENSE', 'd-ops', '25000.00', '0'),
      act('sal', '6100', 'EXPENSE', 'unknown', '1000.00', '0'),
    ]);
    expect(r.columns.map((c) => c.name)).toEqual(['Sales', 'Operations', 'People', 'Not assigned']);
    expect(r.sections[0]).toMatchObject({ type: 'REVENUE', totals: ['95000.00', '0.00', '0.00', '20000.00'], total: '115000.00' });
    expect(r.sections[1]!.rows.map((x) => [x.code, x.amounts, x.total])).toEqual([
      ['6100', ['40000.00', '25000.00', '0.00', '1000.00'], '66000.00'],
      ['6200', ['0.00', '30000.00', '0.00', '0.00'], '30000.00'],
    ]);
    expect(r.netProfit).toEqual(['55000.00', '-55000.00', '0.00', '19000.00']);
    expect(r.netProfitTotal).toBe('19000.00');
    expect(r.margin).toEqual(['57.9', null, null, '95.0']);
  });

  it('drops accounts that net to zero', () => {
    const r = profitByDimension(values, [act('rev', '4100', 'REVENUE', 'd-sales', '100.00', '100.00')]);
    expect(r.sections[0]!.rows).toEqual([]);
    expect(r.netProfitTotal).toBe('0.00');
  });
});
