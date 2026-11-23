import { describe, expect, it } from 'vitest';
import { financialTimeline, timelineBucketSize, timelineBucketStart, type TimelineEntryInput } from '../src';

const e = (id: string, date: string, source: string, cashIn = '0', cashOut = '0', amount = '100'): TimelineEntryInput => ({ id, entryNumber: Number(id), date, source, reference: null, memo: null, amount, cashIn, cashOut });

describe('financial timeline', () => {
  it('chooses days, weeks or months by the length of the range', () => {
    expect(timelineBucketSize('2026-01-01', '2026-03-03')).toBe('DAY');
    expect(timelineBucketSize('2026-01-01', '2026-03-04')).toBe('WEEK');
    expect(timelineBucketSize('2026-01-01', '2026-12-31')).toBe('MONTH');
    expect(timelineBucketStart('2026-11-22', 'WEEK')).toBe('2026-11-16'); // a Sunday → its Monday
    expect(timelineBucketStart('2026-11-23', 'WEEK')).toBe('2026-11-23');
    expect(timelineBucketStart('2026-11-23', 'MONTH')).toBe('2026-11-01');
  });

  it('buckets cash and entries, carries the cash balance, and leaves the future without one', () => {
    const t = financialTimeline({
      from: '2026-09-01',
      to: '2026-12-31',
      today: '2026-11-23',
      size: 'MONTH',
      openingCash: '1000.00',
      entries: [e('2', '2026-09-10', 'DOCUMENT', '0', '0', '500'), e('1', '2026-09-05', 'PAYMENT', '300', '0', '300'), e('3', '2026-10-02', 'PAYROLL', '0', '450.5', '450.5'), e('4', '2026-11-20', 'PAYMENT', '100', '0'), e('5', '2026-08-31', 'PAYMENT', '999')],
      deadlines: [{ key: 'b', date: '2026-12-20', name: 'GSTR-3B', status: 'UPCOMING' }, { key: 'a', date: '2026-11-11', name: 'GSTR-1', status: 'DONE' }, { key: 'x', date: '2027-01-07', name: 'TDS', status: 'UPCOMING' }],
      scale: 2,
    });
    expect(t.buckets.map((b) => [b.start, b.end, b.cashIn, b.cashOut, b.closingCash, b.entries, b.deadlines, b.future])).toEqual([
      ['2026-09-01', '2026-09-30', '300.00', '0.00', '1300.00', 2, 0, false],
      ['2026-10-01', '2026-10-31', '0.00', '450.50', '849.50', 1, 0, false],
      ['2026-11-01', '2026-11-30', '100.00', '0.00', '949.50', 1, 1, false],
      ['2026-12-01', '2026-12-31', '0.00', '0.00', null, 0, 1, true],
    ]);
    expect(t.buckets[0]!.bySource).toEqual([{ source: 'DOCUMENT', count: 1 }, { source: 'PAYMENT', count: 1 }]);
    expect(t.entries.map((x) => x.id)).toEqual(['1', '2', '3', '4']);
    expect(t.deadlines.map((d) => [d.name, d.bucket])).toEqual([['GSTR-1', '2026-11-01'], ['GSTR-3B', '2026-12-01']]);
    expect(t.sources).toEqual([{ source: 'PAYMENT', count: 2, amount: '400.00' }, { source: 'DOCUMENT', count: 1, amount: '500.00' }, { source: 'PAYROLL', count: 1, amount: '450.50' }]);
    expect(t.totals).toEqual({ openingCash: '1000.00', cashIn: '400.00', cashOut: '450.50', closingCash: '949.50', entries: 4, deadlines: 2 });
  });

  it('weeks start on Monday and cover a range that starts mid-week', () => {
    const t = financialTimeline({ from: '2026-11-04', to: '2026-11-17', today: '2026-11-30', size: 'WEEK', openingCash: '0', entries: [e('1', '2026-11-04', 'BANK', '10')], deadlines: [], scale: 2 });
    expect(t.buckets.map((b) => b.start)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(t.buckets[0]!.cashIn).toBe('10.00');
  });
});
