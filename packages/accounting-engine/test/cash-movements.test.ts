import { describe, expect, it } from 'vitest';
import { forecastCashMovements, recurringMovements, type CashMovementLine } from '../src/cash-movements';
import { D } from '../src/money';

const asOf = '2026-11-18';
let n = 0;
const l = (date: string, amount: string, description: string): CashMovementLine => ({ id: `l${String(++n).padStart(3, '0')}`, date, amount, description });
const lines: CashMovementLine[] = [
  ...['06', '07', '08', '09', '10', '11'].map((m) => l(`2026-${m}-05`, '-50000.00', `RENT ${m} SHREE ESTATES`)),
  ...Array.from({ length: 11 }, (_, k) => l(new Date(Date.parse('2026-09-02T00:00:00Z') + k * 7 * 86_400_000).toISOString().slice(0, 10), k % 2 ? '13000.00' : '12000.00', `UPI CR SWIGGY SETTLEMENT ${k}`)),
  l('2025-12-10', '-8000.00', 'LIC PREMIUM'),
  l('2026-03-10', '-8000.00', 'LIC PREMIUM'),
  l('2026-06-10', '-8000.00', 'LIC PREMIUM'),
  l('2026-08-15', '-3000.00', 'ELECTRICITY BILL'),
  l('2026-09-15', '-6000.00', 'ELECTRICITY BILL'),
  l('2026-10-15', '-3100.00', 'ELECTRICITY BILL'),
  l('2026-10-20', '30000.00', 'NEFT CR CUSTOMER A'),
  l('2026-11-01', '-2000.00', 'POS DR AMAZON'),
  l('2026-11-19', '-999.00', 'AFTER AS OF'),
];

describe('cash movements', () => {
  it('finds movements that repeat, and which still run', () => {
    const r = recurringMovements(lines, asOf, 90, 2);
    expect(r.map((x) => [x.narration, x.direction, x.frequency, x.amount, x.count, x.running])).toEqual([
      ['RENT 11 SHREE ESTATES', 'OUT', 'MONTHLY', '-50000.00', 6, true],
      ['UPI CR SWIGGY SETTLEMENT 10', 'IN', 'WEEKLY', '12000.00', 11, true],
      ['LIC PREMIUM', 'OUT', 'QUARTERLY', '-8000.00', 3, false],
    ]);
    expect(r[0]!.next.map((x) => x.date)).toEqual(['2026-12-05', '2027-01-05', '2027-02-05']);
    expect(r[1]!.spreadPercent).toBe(8);
    expect(r[1]!.next[0]).toEqual({ date: '2026-11-19', amount: '12000.00', late: true });
    expect(r[1]!.next[1]!.date).toBe('2026-11-25');
    expect(r[1]!.next.at(-1)!.date).toBe('2027-02-10');
    expect(r[2]!.next).toEqual([]);
  });

  it('forecasts the balance week by week from the books and the rest of the movements', () => {
    const f = forecastCashMovements(lines, '200000.00', asOf, 30, 2);
    expect(f.basis).toEqual({ lines: 25, from: '2025-12-10', to: '2026-11-11', otherWeeks: 13 });
    expect(f.thin).toBe(false);
    // The rest of the last 13 weeks: electricity (two bills), the customer and Amazon.
    expect(f.other.weeklyIn).toBe(new D('30000').div(13).toFixed(2));
    expect(f.other.weeklyOut).toBe(new D('-11100').div(13).toFixed(2));
    expect(f.weeks.map((w) => [w.from, w.to])).toEqual([
      ['2026-11-19', '2026-11-25'],
      ['2026-11-26', '2026-12-02'],
      ['2026-12-03', '2026-12-09'],
      ['2026-12-10', '2026-12-16'],
      ['2026-12-17', '2026-12-18'],
    ]);
    // Swiggy late and on 25 Nov in week one; rent on 5 Dec in week three.
    expect(f.weeks[0]!.recurringIn).toBe('24000.00');
    expect(f.weeks[2]!.recurringOut).toBe('-50000.00');
    const expected = new D('200000').plus(12000 * 5).minus(50000).plus(new D('18900').div(13).times(30).div(7));
    expect(f.endBalance).toBe(expected.toFixed(2));
    expect(new D(f.weeks.at(-1)!.low).lte(f.endBalance)).toBe(true);
    expect(new D(f.weeks.at(-1)!.high).gte(f.endBalance)).toBe(true);
    expect(f.lowest.weekTo).toBe('2026-12-09');
  });

  it('says when there is too little history', () => {
    const f = forecastCashMovements([l('2026-11-10', '500.00', 'CASH DEPOSIT')], '1000.00', asOf, 30, 2);
    expect(f).toMatchObject({ thin: true, recurring: [], basis: { lines: 1, otherWeeks: 2 } });
    expect(forecastCashMovements([], '1000.00', asOf, 30, 2)).toMatchObject({ endBalance: '1000.00', basis: { lines: 0, from: null, otherWeeks: 0 } });
  });
});
