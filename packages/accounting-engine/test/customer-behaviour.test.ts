import { describe, expect, it } from 'vitest';
import { customerBehaviour, usualPayDay, type BehaviourInvoice } from '../src/customer-behaviour';
import { addDays } from '../src/documents';

const T = '2026-11-21';
/** An invoice issued `ago` days before T, due 30 days later, paid `late` days after its due date (null: open). */
const inv = (ago: number, total: string, late: number | null = 0, payments = 1): BehaviourInvoice => {
  const issueDate = addDays(T, -ago);
  const dueDate = addDays(issueDate, 30);
  return { issueDate, dueDate, total, paidOn: late == null ? null : addDays(dueDate, late), payments: late == null ? 0 : payments };
};

describe('customer behaviour (AR-038)', () => {
  it('sees a customer paying slower than six months before', () => {
    const b = customerBehaviour([inv(330, '1000', 2), inv(300, '1000', 2), inv(270, '1000', 2), inv(240, '1000', 2), inv(150, '1000', 20), inv(120, '1000', 20), inv(90, '1000', 20), inv(20, '1000', null)], [], T, 2);
    expect(b.paying).toMatchObject({ paidInvoices: 7, daysLate: 10, daysLateRecent: 20, daysLatePrior: 2, trend: 'SLOWER', spread: 9, partialShare: 0, payDay: null });
    expect(b.profile).toBe('SLOW');
    expect(b.profileLabel).toBe('Pays late, steadily');
    expect(b.signals.map((s) => [s.code, s.tone])).toEqual([['PAYING_SLOWER', 'RISK']]);
    expect(b.signals[0]!.detail).toBe('Paying 18 days later than six months before: 20 days late on average, was 2');
    expect(b.buying).toMatchObject({ last12: { invoices: 8, amount: '8000.00' }, prior12: { invoices: 0, amount: '0.00' }, change: null, trend: 'NEW' });
  });

  it('sees a prompt payer buying more, with a usual pay day', () => {
    const b = customerBehaviour([inv(500, '1000'), inv(450, '1000'), inv(300, '1000'), inv(240, '1000'), inv(180, '1000'), inv(120, '1000')], ['2026-06-05', '2026-07-04', '2026-08-06', '2026-09-05', '2026-10-20'], T, 2);
    expect(b.profile).toBe('PROMPT');
    expect(b.paying).toMatchObject({ daysLate: 0, spread: 0, payDay: 5 });
    expect(b.buying).toMatchObject({ last12: { invoices: 4, amount: '4000.00' }, prior12: { invoices: 2, amount: '2000.00' }, change: 100, trend: 'GROWING' });
    expect(b.signals.map((s) => s.code)).toEqual(['BUYING_MORE', 'PAY_DAY']);
    expect(b.signals[1]!.detail).toBe('Usually pays around the 5th of the month: time reminders a few days before');
  });

  it('sees a customer who has stopped buying, and one buying less', () => {
    const lapsed = customerBehaviour([inv(400, '1000'), inv(370, '1000'), inv(340, '1000'), inv(310, '1000'), inv(280, '1000')], [], T, 2);
    expect(lapsed.buying).toMatchObject({ trend: 'LAPSED', daysSinceLast: 280, averageGap: 30 });
    expect(lapsed.signals.map((s) => s.code)).toEqual(['LAPSED']);
    expect(lapsed.signals[0]!.detail).toBe('No invoice for 280 days; usually one every 30 days');
    const less = customerBehaviour([inv(600, '2000'), inv(500, '2000'), inv(60, '1000'), inv(30, '1000', null)], [], T, 2);
    expect(less.buying).toMatchObject({ change: -50, trend: 'SHRINKING' });
    expect(less.signals.map((s) => s.code)).toEqual(['BUYING_LESS']);
    expect(less.signals[0]!.detail).toMatch(/50% less .*\(2000\.00 against 4000\.00\)/);
  });

  it('sees an unpredictable payer who pays in parts', () => {
    const b = customerBehaviour([inv(330, '1000', 0), inv(270, '1000', 60, 2), inv(200, '1000', 0), inv(150, '1000', 50, 3)], [], T, 2);
    expect(b.paying).toMatchObject({ spread: 28, partialShare: 50 });
    expect(b.profile).toBe('ERRATIC');
    expect(b.signals.map((s) => s.code)).toContain('PARTIAL_PAYER');
  });

  it('holds back with new customers and too little history', () => {
    expect(customerBehaviour([inv(30, '1000', null)], [], T, 2).profile).toBe('NEW');
    const thin = customerBehaviour([inv(200, '1000', 3), inv(150, '1000', 4)], [], T, 2);
    expect(thin.profile).toBe('LITTLE_HISTORY');
    expect(thin.paying.trend).toBeNull();
    expect(thin.paying.spread).toBeNull();
    const none = customerBehaviour([], [], T, 2);
    expect(none.buying).toMatchObject({ trend: null, lastInvoiceOn: null, averageGap: null });
  });

  it('finds a usual pay day only when most receipts cluster', () => {
    // Around the turn of the month: the 31st and the 1st fit equally; the first found is kept.
    expect(usualPayDay(['2026-01-30', '2026-02-01', '2026-03-31', '2026-04-02'])).toBe(1);
    expect(usualPayDay(['2026-01-01', '2026-02-10', '2026-03-20', '2026-04-28'])).toBeNull();
    expect(usualPayDay(['2026-01-05', '2026-02-05', '2026-03-05'])).toBeNull();
  });
});
