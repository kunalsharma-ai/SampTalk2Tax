import { describe, expect, it } from 'vitest';
import { creditRisk, grossProfit, lifetimeValue, monthRange, paymentBehaviour, retention } from '../src/customer-insights';

const TODAY = '2026-11-06';

describe('payment behaviour', () => {
  it('weights days to pay and days late by invoice total, and finds the oldest overdue invoice', () => {
    const b = paymentBehaviour(
      [
        { issueDate: '2026-01-01', dueDate: '2026-01-31', total: '1000', outstanding: '0', paidOn: '2026-01-31' }, // 30 to pay, on time
        { issueDate: '2026-02-01', dueDate: '2026-03-03', total: '3000', outstanding: '0', paidOn: '2026-03-23' }, // 50 to pay, 20 late
        { issueDate: '2026-09-01', dueDate: '2026-10-01', total: '500', outstanding: '500', paidOn: null }, // 36 days overdue
        { issueDate: '2026-10-20', dueDate: '2026-11-19', total: '700', outstanding: '200', paidOn: null }, // not due
      ],
      TODAY,
    );
    expect(b.invoices).toBe(4);
    expect(b.paidInvoices).toBe(2);
    expect(b.averageDaysToPay).toBe(45); // (30×1000 + 50×3000) / 4000
    expect(b.averageDaysLate).toBe(15); // (0 + 20×3000) / 4000
    expect(b.onTimeShare).toBe(0.5);
    expect(b.open).toBe('700');
    expect(b.overdue).toBe('500');
    expect(b.oldestOverdueDays).toBe(36);
    expect(b.recentDaysLate).toBeNull();
    expect(b.earlierDaysLate).toBe(15);
  });

  it('has nothing to average with no paid invoices', () => {
    const b = paymentBehaviour([], TODAY);
    expect(b).toMatchObject({ invoices: 0, averageDaysToPay: null, averageDaysLate: null, onTimeShare: null, open: '0', overdue: '0', oldestOverdueDays: 0 });
  });
});

describe('credit risk', () => {
  const base = { creditLimit: null, averageMonthlyBilling: '40000', paymentTermsDays: 30, minorUnits: 2 };

  it('rates a customer who pays on time as low risk and suggests a limit', () => {
    const behaviour = paymentBehaviour([{ issueDate: '2026-09-01', dueDate: '2026-10-01', total: '40000', outstanding: '0', paidOn: '2026-09-28' }], TODAY);
    const r = creditRisk({ ...base, behaviour });
    expect(r.score).toBe(0);
    expect(r.rating).toBe('LOW');
    expect(r.factors).toHaveLength(5);
    expect(r.suggestedLimit).toBe('80000.00'); // a month of billing plus 30 days of terms
  });

  it('adds points for overdue money, age, lateness, limit use and slowing down', () => {
    const behaviour = paymentBehaviour(
      [
        { issueDate: '2026-01-01', dueDate: '2026-01-31', total: '10000', outstanding: '0', paidOn: '2026-02-02' }, // 2 late, earlier
        { issueDate: '2026-08-01', dueDate: '2026-08-31', total: '10000', outstanding: '0', paidOn: '2026-10-15' }, // 45 late, recent
        { issueDate: '2026-06-01', dueDate: '2026-07-01', total: '30000', outstanding: '30000', paidOn: null }, // 128 days overdue
      ],
      TODAY,
    );
    const r = creditRisk({ ...base, creditLimit: '25000', behaviour });
    const pts = Object.fromEntries(r.factors.map((f) => [f.key, f.points]));
    expect(pts).toEqual({ OVERDUE_SHARE: 30, OLDEST_OVERDUE: 25, DAYS_LATE: 12, LIMIT_USAGE: 15, SLOWING: 10 });
    expect(r.score).toBe(92);
    expect(r.rating).toBe('VERY_HIGH');
    expect(r.suggestedLimit).toBeNull();
    expect(r.factors.find((f) => f.key === 'SLOWING')!.detail).toBe('45 days late in the last 90 days, against 2 before');
  });

  it('halves the suggested limit for medium risk and gives no rating without invoices', () => {
    const behaviour = paymentBehaviour(
      [
        { issueDate: '2026-09-01', dueDate: '2026-10-01', total: '10000', outstanding: '0', paidOn: '2026-10-20' }, // 19 late
        { issueDate: '2026-10-01', dueDate: '2026-10-31', total: '10000', outstanding: '10000', paidOn: null }, // 6 overdue
      ],
      TODAY,
    );
    const r = creditRisk({ ...base, behaviour });
    expect(r.score).toBe(30 + 5 + 12);
    expect(r.rating).toBe('MEDIUM');
    expect(r.suggestedLimit).toBe('40000.00');
    expect(creditRisk({ ...base, behaviour: paymentBehaviour([], TODAY) })).toEqual({ score: null, rating: 'NO_HISTORY', factors: [], suggestedLimit: null });
  });
});

describe('lifetime value', () => {
  it('uses measured retention for the years ahead, at most five', () => {
    const prev = new Set(['a', 'b', 'c', 'd', 'e']);
    expect(retention(prev, new Set(['a', 'b', 'c', 'x']))).toEqual({ rate: 0.6, customers: 5, retained: 3 });
    expect(retention(new Set(['a', 'b']), new Set(['a'])).rate).toBeNull();
    const v = lifetimeValue({ revenueToDate: '500000', profitToDate: '200000', trailingRevenue: '240000', trailingProfit: '96000', contractArr: '120000', retentionRate: 0.6, active: true, minorUnits: 2 });
    expect(v.margin).toBe('0.4');
    expect(v.annualRevenue).toBe('240000.00');
    expect(v.annualProfit).toBe('96000.00');
    expect(v.expectedYears).toBe('1.5'); // 0.6 / 0.4
    expect(v.value).toBe('344000.00');
    expect(v.assumedYears).toBe(false);
    expect(lifetimeValue({ revenueToDate: '1', profitToDate: '1', trailingRevenue: '1', trailingProfit: '1', contractArr: '0', retentionRate: 0.95, active: true, minorUnits: 2 }).expectedYears).toBe('5.0');
  });

  it('takes the contract value when it is larger, assumes three years without data, and expects nothing from a lapsed customer', () => {
    const v = lifetimeValue({ revenueToDate: '100000', profitToDate: '100000', trailingRevenue: '50000', trailingProfit: '50000', contractArr: '120000', retentionRate: null, active: true, minorUnits: 2 });
    expect(v.annualRevenue).toBe('120000.00');
    expect(v.expectedYears).toBe('3.0');
    expect(v.assumedYears).toBe(true);
    expect(v.value).toBe('460000.00');
    const lapsed = lifetimeValue({ revenueToDate: '100000', profitToDate: '30000', trailingRevenue: '0', trailingProfit: '0', contractArr: '0', retentionRate: 0.5, active: false, minorUnits: 2 });
    expect(lapsed.margin).toBe('0.3');
    expect(lapsed.value).toBe('30000.00');
  });

  it('lists months and works out gross profit', () => {
    expect(monthRange('2025-11-06', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(grossProfit('1000', '250')).toEqual({ profit: '750', margin: '0.75' });
    expect(grossProfit('0', '250')).toEqual({ profit: '-250', margin: null });
  });
});
