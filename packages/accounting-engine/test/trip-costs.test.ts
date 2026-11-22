import { describe, expect, it } from 'vitest';
import { tripCosts } from '../src';

const trip = { startDate: '2026-10-05', endDate: '2026-10-07', estimate: { transport: '12000', lodging: '9000', meals: '3000', other: '0' } };
const claim = (id: string, status: string, lines: [string, string, string][]) => ({ id, number: `EC-${id}`, status, lines: lines.map(([date, account, amount], i) => ({ lineNo: i + 1, date, account, merchant: null, amount })) });

describe('trip costs', () => {
  it('splits spent and pending by category against the estimate', () => {
    const r = tripCosts(trip, [
      claim('1', 'REIMBURSED', [['2026-10-05', '6300 Travel', '11000.00'], ['2026-10-06', '6310 Hotels', '6000.00']]),
      claim('2', 'SUBMITTED', [['2026-10-07', '6310 Hotels', '3000.00'], ['2026-10-07', '6320 Meals', '1500.50']]),
      claim('3', 'VOID', [['2026-10-06', '6300 Travel', '99999.00']]),
    ]);
    expect(r).toMatchObject({ days: 3, spent: '17000.00', pending: '4500.50', remaining: '2499.50', perDay: '5666.67', flags: [], outsideDates: [] });
    expect(r.estimate.total).toBe('24000.00');
    expect(r.estimate.lines[1]).toEqual({ key: 'lodging', label: 'Hotels and lodging', amount: '9000.00' });
    expect(r.byCategory).toEqual([
      { account: '6300 Travel', spent: '11000.00', pending: '0.00' },
      { account: '6310 Hotels', spent: '6000.00', pending: '3000.00' },
      { account: '6320 Meals', spent: '0.00', pending: '1500.50' },
    ]);
  });

  it('flags an overrun and lines dated outside the trip, with a day of grace', () => {
    const r = tripCosts(trip, [
      claim('1', 'APPROVED', [['2026-10-04', '6300 Travel', '20000.00'], ['2026-10-08', '6310 Hotels', '4000.00'], ['2026-10-09', '6320 Meals', '1200.00']]),
      claim('2', 'DRAFT', [['2026-10-02', '6399 Other', '800.00']]),
    ]);
    expect(r.flags).toEqual([
      { code: 'OVER_ESTIMATE', message: 'Claims come to 2000.00 (8.3%) more than the estimate' },
      { code: 'OUTSIDE_DATES', message: '2 lines are dated outside the trip' },
    ]);
    expect(r.outsideDates.map((l) => [l.number, l.lineNo, l.date])).toEqual([['EC-1', 3, '2026-10-09'], ['EC-2', 1, '2026-10-02']]);
    expect(r.remaining).toBe('-2000.00');
  });

  it('handles a trip with no estimate and no claims', () => {
    const empty = tripCosts({ ...trip, estimate: { transport: '0', lodging: '0', meals: '0', other: '0' } }, []);
    expect(empty).toMatchObject({ spent: '0.00', pending: '0.00', perDay: '0.00', flags: [] });
    const r = tripCosts({ ...trip, estimate: { transport: '0', lodging: '0', meals: '0', other: '0' } }, [claim('1', 'SUBMITTED', [['2026-10-05', '6300 Travel', '500.00']])]);
    expect(r.flags[0]!.message).toBe('Claims come to 500.00 with no estimate');
  });
});
