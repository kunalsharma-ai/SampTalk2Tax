import { describe, expect, it } from 'vitest';
import { reminderResults, type SentReminder } from '../src';

const r = (id: string, contactId: string, sentOn: string, overdueThen: string, currency = 'INR'): SentReminder => ({ id, contactId, customer: `Customer ${contactId}`, sentOn, currency, overdueThen });

describe('what payment reminders achieved', () => {
  it('counts receipts in the window after a reminder, up to what was overdue', () => {
    const { results, byCurrency } = reminderResults(
      [r('a', 'c1', '2026-10-01', '50000.00'), r('b', 'c2', '2026-10-05', '20000.00'), r('c', 'c3', '2026-10-10', '9000.00')],
      [
        { contactId: 'c1', date: '2026-10-08', currency: 'INR', amount: '30000.00' },
        { contactId: 'c1', date: '2026-10-20', currency: 'INR', amount: '40000.00' }, // only 20,000 more was overdue
        { contactId: 'c2', date: '2026-09-30', currency: 'INR', amount: '5000.00' }, // before the reminder
        { contactId: 'c2', date: '2026-11-10', currency: 'INR', amount: '5000.00' }, // after the window
        { contactId: 'c3', date: '2026-10-12', currency: 'USD', amount: '9000.00' }, // another currency
      ],
      '2026-11-19',
    );
    const by = Object.fromEntries(results.map((x) => [x.id, x]));
    expect(by.a).toMatchObject({ collected: '50000.00', outcome: 'PAID', daysToFirstPayment: 7, windowEnds: '2026-10-31' });
    expect(by.b).toMatchObject({ collected: '0.00', outcome: 'NOT_PAID', daysToFirstPayment: null });
    expect(by.c).toMatchObject({ collected: '0.00', outcome: 'NOT_PAID' });
    expect(results.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(byCurrency).toEqual([{ currency: 'INR', reminders: 3, overdueThen: '79000.00', collected: '50000.00', collectedShare: '63.3', paid: 1, partPaid: 0, notPaid: 2, waiting: 0, averageDaysToPay: 7 }]);
  });

  it('gives a receipt to the latest reminder before it, never to two', () => {
    const { results } = reminderResults([r('first', 'c1', '2026-11-01', '10000.00'), r('second', 'c1', '2026-11-10', '10000.00')], [{ contactId: 'c1', date: '2026-11-12', currency: 'INR', amount: '4000.00' }], '2026-11-19');
    const by = Object.fromEntries(results.map((x) => [x.id, x]));
    expect(by.second).toMatchObject({ collected: '4000.00', outcome: 'PART_PAID', daysToFirstPayment: 2 });
    expect(by.first).toMatchObject({ collected: '0.00', outcome: 'WAITING' });
  });

  it('does not count a receipt recorded earlier on the day the reminder went', () => {
    const m = { ...r('d', 'c1', '2026-11-19', '5000.00'), sentAt: '2026-11-19T10:00:00.000Z' };
    const before = { contactId: 'c1', date: '2026-11-19', currency: 'INR', amount: '1000.00', recordedAt: '2026-11-19T09:00:00.000Z' };
    const after = { ...before, amount: '2000.00', recordedAt: '2026-11-19T11:00:00.000Z' };
    expect(reminderResults([m], [before, after], '2026-11-19').results[0]).toMatchObject({ collected: '2000.00', outcome: 'PART_PAID', daysToFirstPayment: 0 });
  });

  it('waits while the window is open, and summarises each currency apart', () => {
    const { byCurrency } = reminderResults([r('x', 'c1', '2026-11-15', '100.00', 'USD'), r('y', 'c2', '2026-11-15', '0.00')], [], '2026-11-19', 14);
    expect(byCurrency).toEqual([
      { currency: 'INR', reminders: 1, overdueThen: '0.00', collected: '0.00', collectedShare: null, paid: 0, partPaid: 0, notPaid: 0, waiting: 1, averageDaysToPay: null },
      { currency: 'USD', reminders: 1, overdueThen: '100.00', collected: '0.00', collectedShare: '0.0', paid: 0, partPaid: 0, notPaid: 0, waiting: 1, averageDaysToPay: null },
    ]);
    expect(() => reminderResults([], [], '2026-11-19', 0)).toThrow('at least 1');
  });
});
