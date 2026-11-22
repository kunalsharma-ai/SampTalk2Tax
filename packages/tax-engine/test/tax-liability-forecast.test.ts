import { describe, expect, it } from 'vitest';
import { taxLiabilityForecast } from '../src';

const o = (key: string, dueDate: string, extra: Record<string, unknown>) => ({ key, kind: key.split(':')[0]!, name: key.split(':')[0]!, area: 'GST', period: key.split(':')[1]!, periodLabel: key.split(':')[1]!, dueDate, ...extra });

describe('taxLiabilityForecast', () => {
  it('uses what the books know, the plan, or the recent average with a range', () => {
    const f = taxLiabilityForecast([
      o('GSTR3B:2026-11', '2026-12-20', { history: ['1000', '2000', '3000', '4000', '5000', '6000'] }),
      o('GSTR3B:2026-10', '2026-11-20', { known: '4200.456' }),
      o('ADVANCE_TAX:Q3', '2026-12-15', { plan: '15000' }),
      o('PT:2026-11', '2026-12-31', { history: [] }),
      o('TDS_DEPOSIT:2026-11', '2026-12-07', { known: '-5', history: ['900'] }),
    ]);
    expect(f.items.map((i) => `${i.key} ${i.method} ${i.amount}`)).toEqual([
      'GSTR3B:2026-10 KNOWN 4200.46',
      'TDS_DEPOSIT:2026-11 KNOWN 0.00',
      'ADVANCE_TAX:Q3 PLAN 15000.00',
      'GSTR3B:2026-11 AVERAGE 5000.00',
      'PT:2026-11 NO_HISTORY 0.00',
    ]);
    const avg = f.items.find((i) => i.method === 'AVERAGE')!;
    // Standard deviation of 1,000..6,000 is 1,707.83.
    expect([avg.low, avg.high]).toEqual(['3292.17', '6707.83']);
    expect(avg.basis).toBe('Average of the last 3 periods (4000.00, 5000.00, 6000.00); 2026-11 has not ended yet.');
    expect(f.months).toEqual([
      { month: '2026-11', amount: '4200.46', low: '4200.46', high: '4200.46', known: '4200.46', payments: 1 },
      { month: '2026-12', amount: '20000.00', low: '18292.17', high: '21707.83', known: '15000.00', payments: 4 },
    ]);
    expect(f.totals).toEqual({ amount: '24200.46', low: '22492.63', high: '25908.29', known: '19200.46' });
  });

  it('formats money in the basis when given a formatter, and never forecasts below zero', () => {
    const f = taxLiabilityForecast([o('TCS_DEPOSIT:2026-11', '2026-12-07', { history: ['100', '0', '0'], note: 'Collected on sales.' })], { money: (a) => `₹${a}` });
    expect(f.items[0]).toMatchObject({ amount: '33.33', low: '0.00', basis: 'Average of the last 3 periods (₹100.00, ₹0.00, ₹0.00); 2026-11 has not ended yet. Collected on sales.' });
  });
});
