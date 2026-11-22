import { describe, expect, it } from 'vitest';
import { predictPaymentDates, type BillToPredict } from '../src/predictive-payments';

const asOf = '2026-11-18';
const money = (a: string) => `INR ${a}`;
const bill = (number: string, dueDate: string, due: string, more: Partial<BillToPredict> = {}): BillToPredict => ({ id: number, number, vendor: `Vendor ${number}`, dueDate, due, score: 50, inBatch: null, blocked: false, ...more });
const bills = [
  bill('A', '2026-11-10', '30000.00', { score: 60 }),
  bill('B', '2026-11-20', '40000.00'),
  bill('C', '2026-11-22', '25000.00'),
  bill('D', '2026-11-26', '60000.00'),
  bill('E', '2026-11-19', '15000.00', { inBatch: 'PB-0001' }),
  bill('F', '2026-11-21', '5000.00', { blocked: true }),
  bill('G', '2026-12-30', '7000.00'),
];
const receipts = [
  { id: 'r1', number: 'INV-1', customer: 'Harbour Cafe', date: '2026-11-25', amount: '50000.00' },
  { id: 'r2', number: 'INV-2', customer: 'Teak House', date: '2026-12-01', amount: '10000.00' },
  { id: 'r3', number: 'INV-3', customer: 'Late Payer', date: '2027-02-01', amount: '99000.00' },
];

describe('predictive payment dates', () => {
  const r = predictPaymentDates({ bills, receipts, cash: '100000.00', buffer: '20000.00', asOf, days: 30, scale: 2, money });
  const by = (n: string) => r.bills.find((b) => b.number === n)!;

  it('pays on the due date when the cash allows, later when receipts are needed, and says why', () => {
    expect(r.bills.map((b) => [b.number, b.status, b.payOn, b.daysLate])).toEqual([
      ['A', 'OVERDUE_NOW', asOf, 8],
      ['C', 'ON_DUE', '2026-11-22', 0],
      ['B', 'DELAYED', '2026-11-25', 5],
      ['D', 'NOT_COVERED', null, 0],
      ['E', 'IN_BATCH', null, 0],
      ['F', 'BLOCKED', null, 0],
      ['G', 'AFTER_PERIOD', null, 0],
    ]);
    expect(by('B').reason).toBe('Waits 5 days past its due date for 1 expected receipt, the largest INR 50000.00 from Harbour Cafe (INV-1) by 25 Nov 2026');
    expect(by('A').reason).toBe('8 days overdue; the cash covers it today');
    expect(by('D').reason).toBe('The cash expected in the next 30 days does not cover INR 60000.00 and keep INR 20000.00 in the bank');
    expect(by('G').reason).toBe('Due after 18 Dec 2026');
  });

  it('shows the cash week by week and sums it up', () => {
    expect(r.weeks.map((w) => [w.from, w.receipts, w.payments, w.closing])).toEqual([
      ['2026-11-18', '0.00', '-70000.00', '30000.00'],
      ['2026-11-25', '60000.00', '-40000.00', '50000.00'],
      ['2026-12-02', '0.00', '0.00', '50000.00'],
      ['2026-12-09', '0.00', '0.00', '50000.00'],
      ['2026-12-16', '0.00', '0.00', '50000.00'],
    ]);
    expect(r.summary).toEqual({
      cash: '100000.00',
      buffer: '20000.00',
      receipts: '60000.00',
      onTime: { count: 2, amount: '55000.00' },
      delayed: { count: 1, amount: '40000.00', averageDaysLate: 5 },
      notCovered: { count: 1, amount: '60000.00' },
      inBatches: '15000.00',
      blocked: { count: 1, amount: '5000.00' },
      afterPeriod: { count: 1, amount: '7000.00' },
      endBalance: '50000.00',
      lowest: { balance: '30000.00', date: '2026-11-22' },
    });
  });

  it('never goes below the buffer on any day once a bill is paid', () => {
    const one = predictPaymentDates({ bills: [bill('X', '2026-11-19', '90000.00')], receipts: [{ id: 'r', number: 'INV-9', customer: 'C', date: '2026-11-17', amount: '5000.00' }], cash: '100000.00', buffer: '10000.00', asOf, days: 30, scale: 2, money });
    // A receipt predicted for a day already past counts today.
    expect(one.bills[0]).toMatchObject({ status: 'ON_DUE', payOn: '2026-11-19' });
    expect(one.summary.lowest).toEqual({ balance: '15000.00', date: '2026-11-19' });
  });
});
