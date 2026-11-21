import { describe, expect, it } from 'vitest';
import { addDays } from '../src/documents';
import { paymentPlanIssue, planProgress, planSchedule, suggestPaymentPlan, type PlanInvoiceInput } from '../src/payment-plans';

const T = '2026-11-21';
const inv = (id: string, dueIn: number, outstanding: string, disputed = false): PlanInvoiceInput => ({ id, number: id.toUpperCase(), dueDate: addDays(T, dueIn), outstanding, disputed });

describe('payment plan schedule', () => {
  it('splits into equal monthly instalments with the rounding on the last', () => {
    expect(planSchedule('100.00', 3, '2026-01-31', 2)).toEqual([
      { no: 1, dueDate: '2026-01-31', amount: '33.33' },
      { no: 2, dueDate: '2026-02-28', amount: '33.33' },
      { no: 3, dueDate: '2026-03-31', amount: '33.34' },
    ]);
    expect(planSchedule('1000', 1, T, 0)).toEqual([{ no: 1, dueDate: T, amount: '1000' }]);
  });

  it('checks the number of instalments and the first date', () => {
    expect(paymentPlanIssue(3, addDays(T, 7), T)).toBeNull();
    expect(paymentPlanIssue(0, T, T)).toMatch(/1 to 12/);
    expect(paymentPlanIssue(13, T, T)).toMatch(/1 to 12/);
    expect(paymentPlanIssue(2.5, T, T)).toMatch(/1 to 12/);
    expect(paymentPlanIssue(3, addDays(T, -1), T)).toMatch(/past/);
    expect(paymentPlanIssue(3, addDays(T, 61), T)).toMatch(/60 days/);
  });
});

describe('suggested payment plans (AR-040)', () => {
  it('sizes the plan to what the customer has been paying a month', () => {
    const s = suggestPaymentPlan(
      [inv('a', -40, '60000.00'), inv('b', -10, '30000.00'), inv('c', 10, '5000.00')],
      [
        { date: addDays(T, -20), amount: '60000.00' },
        { date: addDays(T, -100), amount: '60000.00' },
        { date: addDays(T, -200), amount: '999999.00' },
      ],
      T,
      2,
    )!;
    // 120000 over 6 months = 20000 a month; 90000 / 20000 = 4.5 -> 5 instalments of 18000.
    expect(s.total).toBe('90000.00');
    expect(s.monthlyReceipts).toBe('20000.00');
    expect(s.recommended).toBe(5);
    expect(s.instalments).toBe(5);
    expect(s.firstDueDate).toBe(addDays(T, 7));
    expect(s.schedule.map((i) => i.amount)).toEqual(['18000.00', '18000.00', '18000.00', '18000.00', '18000.00']);
    expect(s.schedule[1]!.dueDate).toBe('2026-12-28');
    expect(s.invoices.map((i) => [i.number, i.daysOverdue])).toEqual([
      ['A', 40],
      ['B', 10],
    ]);
    expect(s.options.map((o) => [o.instalments, o.amount, o.recommended])).toEqual([
      [2, '45000.00', false],
      [3, '30000.00', false],
      [5, '18000.00', true],
      [6, '15000.00', false],
    ]);
    expect(s.reasons[0]).toMatch(/about 20000.00 a month/);
  });

  it('uses 3 instalments with no receipts, at least 2 and at most 12', () => {
    expect(suggestPaymentPlan([inv('a', -5, '900.00')], [], T, 2)!.recommended).toBe(3);
    expect(suggestPaymentPlan([inv('a', -5, '900.00')], [], T, 2)!.reasons[0]).toMatch(/Nothing received/);
    expect(suggestPaymentPlan([inv('a', -5, '100.00')], [{ date: T, amount: '6000.00' }], T, 2)!.recommended).toBe(2);
    const big = suggestPaymentPlan([inv('a', -5, '1000000.00')], [{ date: T, amount: '600.00' }], T, 2)!;
    expect(big.recommended).toBe(12);
    expect(big.reasons[1]).toMatch(/held to 12/);
  });

  it('keeps old debt to 6 months and leaves disputed invoices out', () => {
    const s = suggestPaymentPlan([inv('old', -120, '100000.00'), inv('dis', -30, '5000.00', true)], [{ date: T, amount: '600.00' }], T, 2)!;
    expect(s.recommended).toBe(6);
    expect(s.total).toBe('100000.00');
    expect(s.leftOut).toEqual([{ id: 'dis', number: 'DIS', outstanding: '5000.00' }]);
    expect(s.reasons.join(' ')).toMatch(/over 90 days/);
    expect(s.reasons.join(' ')).toMatch(/1 disputed invoice left out/);
  });

  it('takes the chosen instalments and first date', () => {
    const s = suggestPaymentPlan([inv('a', -5, '1000.00')], [], T, 2, { instalments: 4, firstDueDate: '2026-12-01' })!;
    expect(s.instalments).toBe(4);
    expect(s.recommended).toBe(3);
    expect(s.schedule.map((i) => i.dueDate)).toEqual(['2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01']);
    expect(s.options.map((o) => o.instalments)).toEqual([2, 3, 4, 6]);
  });

  it('suggests nothing without an overdue, undisputed balance', () => {
    expect(suggestPaymentPlan([inv('a', 5, '1000.00')], [], T, 2)).toBeNull();
    expect(suggestPaymentPlan([inv('a', -5, '1000.00', true)], [], T, 2)).toBeNull();
    expect(suggestPaymentPlan([inv('a', -5, '0.00')], [], T, 2)).toBeNull();
  });
});

describe('payment plan progress', () => {
  const sched = [
    { no: 1, dueDate: addDays(T, -40), amount: '100.00' },
    { no: 2, dueDate: addDays(T, -5), amount: '100.00' },
    { no: 3, dueDate: addDays(T, 3), amount: '100.00' },
    { no: 4, dueDate: addDays(T, 30), amount: '100.00' },
  ];

  it('pays instalments in order and says how the plan is going', () => {
    const p = planProgress(sched, '150.00', T, 2);
    expect(p.instalments.map((i) => [i.paid, i.status])).toEqual([
      ['100.00', 'PAID'],
      ['50.00', 'LATE'],
      ['0.00', 'DUE'],
      ['0.00', 'UPCOMING'],
    ]);
    expect(p.status).toBe('BEHIND');
    expect(p.behindBy).toBe('50.00');
    expect(p.remaining).toBe('250.00');
    expect(p.next).toEqual({ no: 2, dueDate: addDays(T, -5), amount: '50.00' });
  });

  it('is broken when an instalment is more than 7 days late, on track when paid up', () => {
    expect(planProgress(sched, '50.00', T, 2).status).toBe('BROKEN');
    const ok = planProgress(sched, '220.00', T, 2);
    expect(ok.status).toBe('ON_TRACK');
    expect(ok.behindBy).toBe('0.00');
    expect(ok.instalments[2]!.status).toBe('PART_PAID');
  });

  it('is completed when everything is paid, and cancelled when cancelled', () => {
    const done = planProgress(sched, '500.00', T, 2);
    expect(done.status).toBe('COMPLETED');
    expect(done.paid).toBe('400.00');
    expect(done.next).toBeNull();
    const c = planProgress(sched, '0', T, 2, true);
    expect(c.status).toBe('CANCELLED');
    expect(c.next).toBeNull();
  });
});
