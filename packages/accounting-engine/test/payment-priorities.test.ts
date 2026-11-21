import { describe, expect, it } from 'vitest';
import { addDays } from '../src/documents';
import { prioritisePayments, type BillToPrioritise } from '../src/payment-priorities';

const T = '2026-11-21';
const bill = (number: string, dueIn: number, due: string, over: Partial<BillToPrioritise> = {}): BillToPrioritise => ({
  id: number,
  number,
  vendorId: `v-${number}`,
  vendor: `Vendor ${number}`,
  issueDate: addDays(T, dueIn - 30),
  dueDate: addDays(T, dueIn),
  due,
  inBatch: null,
  bankVerified: true,
  spendShare: '5',
  ...over,
});
const run = (bills: BillToPrioritise[], cash: string, buffer = '0', rate = '12') => prioritisePayments({ bills, cash, buffer, annualRatePercent: rate, asOf: T, minorUnits: 2 });

describe('payment priorities (AP-030)', () => {
  it('pays urgent bills by score while cash lasts, sets the rest aside for their due dates, and marks what is short', () => {
    const r = run(
      [
        bill('OLD', -40, '30000.00', { spendShare: '30' }),
        bill('SOON', 5, '20000.00'),
        bill('SMALL', -2, '5000.00', { spendShare: null }),
        bill('LATER', 25, '40000.00'),
        bill('BATCHED', 3, '7000.00', { inBatch: 'PB-0001' }),
        bill('NOBANK', -5, '9000.00', { bankVerified: false }),
      ],
      '80000.00',
      '10000.00',
    );
    const by = Object.fromEntries(r.bills.map((b) => [b.number, b]));
    expect(by.OLD).toMatchObject({ score: 50 + 30 + 20, action: 'PAY_NOW' });
    expect(by.OLD!.factors.map((f) => f.detail)).toEqual(['40 days past due', '30% of purchases in the last twelve months', 'Issued 70 days ago']);
    expect(by.SMALL).toMatchObject({ score: 50, action: 'PAY_NOW' });
    expect(by.SOON).toMatchObject({ score: 40, action: 'PAY_NOW' });
    // 80,000 - 10,000 buffer - 7,000 in a batch = 63,000; 55,000 paid now leaves 8,000 for 40,000 due later.
    expect(by.LATER).toMatchObject({ action: 'CASH_SHORT', offer: null });
    expect(by.BATCHED!.action).toBe('IN_BATCH');
    expect(by.NOBANK!.action).toBe('BLOCKED');
    expect(r.summary).toEqual({ cash: '80000.00', buffer: '10000.00', inBatches: '7000.00', available: '63000.00', payNow: '55000.00', onDue: '0.00', short: '40000.00', blocked: '9000.00', leftOver: '8000.00', offers: 0, offerSavings: '0.00', offerPay: '0.00' });
    expect(r.bills.map((b) => b.action)).toEqual(['PAY_NOW', 'PAY_NOW', 'PAY_NOW', 'CASH_SHORT', 'BLOCKED', 'IN_BATCH']);
  });

  it('offers early-payment discounts worth the target return when the cash covers everything (AP-029)', () => {
    const r = run([bill('A', 2, '10000.00'), bill('B', 30, '36500.00'), bill('C', 9, '5000.00'), bill('D', 61, '1000.00')], '100000.00', '0', '12');
    const by = Object.fromEntries(r.bills.map((b) => [b.number, b]));
    expect(by.A!.action).toBe('PAY_NOW');
    // 36,500 × 12% × 30 / 365 = 360.00.
    expect(by.B!.offer).toEqual({ daysEarly: 30, percent: '0.98', discount: '360.00', pay: '36140.00' });
    expect(by.C!.offer).toBeNull();
    // 1,000 × 12% × 61 / 365 = 20.054… rounded down.
    expect(by.D!.offer).toEqual({ daysEarly: 61, percent: '2.00', discount: '20.05', pay: '979.95' });
    expect(r.summary).toMatchObject({ offers: 2, offerSavings: '380.05', offerPay: '37119.95', leftOver: '47500.00' });
  });

  it('makes no offers when any bill is short', () => {
    const r = run([bill('A', -1, '90000.00'), bill('B', 30, '1000.00')], '50000.00');
    expect(r.bills.map((b) => [b.number, b.action, b.offer])).toEqual([['A', 'CASH_SHORT', null], ['B', 'PAY_ON_DUE', null]]);
  });
});
