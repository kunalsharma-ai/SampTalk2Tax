import { describe, expect, it } from 'vitest';
import { scoreReceiptMatch, suggestReceiptMatches, type ReceiptFact, type SpendLine } from '../src/receipt-matching';

const r = (id: string, date: string, amount: string, merchant: string): ReceiptFact => ({ id, date, amount, currency: 'INR', merchant });
const l = (id: string, date: string, amount: string, description: string): SpendLine => ({ id, date, amount, currency: 'INR', description });

describe('receipt matching', () => {
  it('scores amount, date and name, and leaves out what cannot be the payment', () => {
    expect(scoreReceiptMatch(r('a', '2026-11-03', '1180.00', 'Blue Tokai Coffee'), l('x', '2026-11-04', '-1180.00', 'POS 4412 BLUE TOKAI MUMBAI'))).toEqual({
      score: 90,
      confidence: 'HIGH',
      reasons: ['Same amount', '1 day apart (receipt 3 Nov, bank 4 Nov)', '"BLUE" in the bank narration'],
    });
    expect(scoreReceiptMatch(r('a', '2026-11-03', '1000.00', 'Taxi'), l('x', '2026-11-03', '-1015.00', 'UPI DR 99'))).toMatchObject({ score: 55, confidence: 'LOW' });
    expect(scoreReceiptMatch(r('a', '2026-11-03', '1000.00', 'Taxi'), l('x', '2026-11-03', '-1030.00', 'UPI'))).toBeNull(); // over 2%
    expect(scoreReceiptMatch(r('a', '2026-11-03', '1000.00', 'Taxi'), l('x', '2026-11-03', '1000.00', 'UPI'))).toBeNull(); // money in
    expect(scoreReceiptMatch(r('a', '2026-11-03', '1000.00', 'Taxi'), l('x', '2026-11-14', '-1000.00', 'TAXI'))).toBeNull(); // 11 days
    expect(scoreReceiptMatch({ ...r('a', '2026-11-03', '1000.00', 'Taxi'), currency: 'USD' }, l('x', '2026-11-03', '-1000.00', 'TAXI'))).toBeNull();
  });

  it('gives each receipt one line and each line one receipt, and is unsure when two lines fit', () => {
    const s = suggestReceiptMatches(
      [r('a', '2026-11-03', '500.00', 'Chai Point'), r('b', '2026-11-03', '500.00', 'Office Mart'), r('c', '2026-11-10', '2500.00', 'Uber')],
      [l('1', '2026-11-03', '-500.00', 'POS CHAI POINT'), l('2', '2026-11-04', '-500.00', 'POS OFFICE MART'), l('3', '2026-11-10', '-2500.00', 'UPI DR 9988'), l('4', '2026-11-10', '-2500.00', 'UPI DR 7766')],
    );
    expect(s.map((x) => [x.receiptId, x.lineId, x.confidence])).toEqual([
      ['a', '1', 'HIGH'],
      ['b', '2', 'HIGH'],
      ['c', '3', 'MEDIUM'],
    ]);
    expect(s[2]!.alternatives).toBe(1);
    expect(s[2]!.reasons.at(-1)).toBe('Another bank line fits as well: check which one');
  });
});
