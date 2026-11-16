import { describe, expect, it } from 'vitest';
import {
  ALERT_RULES,
  alertPriority,
  alertRule,
  notifies,
  AlertError,
  budgetOverruns,
  D,
  findDuplicates,
  missedRecurringBilling,
  overdueByCustomer,
  resolveAlertParams,
  syncAlerts,
  unusualJournals,
} from '../src';

describe('alert rules and settings', () => {
  it('every rule has a unique key and valid defaults', () => {
    const keys = ALERT_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ALERT_RULES) expect(() => resolveAlertParams(r, null)).not.toThrow();
  });

  it('fills defaults and validates given values', () => {
    const r = alertRule('UNUSUAL_JOURNAL');
    const p = resolveAlertParams(r, { multiple: '3.5' });
    expect(p.multiple.toFixed()).toBe('3.5');
    expect(p.minAmount.toFixed()).toBe('100000');
    expect(p.backdatedDays.toFixed()).toBe('30');
    expect(() => resolveAlertParams(r, { backdatedDays: '2.5' })).toThrow('whole number');
    expect(() => resolveAlertParams(r, { multiple: '1' })).toThrow('from 2 to 100');
    expect(() => resolveAlertParams(r, { multiple: 'abc' })).toThrow(AlertError);
    expect(() => resolveAlertParams(r, { multiple: 5 })).toThrow('enter a number');
    expect(() => resolveAlertParams(r, { colour: '1' })).toThrow('not a setting');
    expect(() => alertRule('NOPE')).toThrow('Unknown check');
  });
});

describe('duplicates', () => {
  const b = (id: string, contactId: string, date: string, amount: string) => ({ id, contactId, date, amount });
  it('groups the same contact and amount within the window, chaining', () => {
    const groups = findDuplicates(
      [
        b('a', 'v1', '2026-10-01', '11800.00'),
        b('b', 'v1', '2026-10-05', '11800'),
        b('c', 'v1', '2026-10-11', '11800.00'), // 6 days after b: chains
        b('d', 'v1', '2026-11-30', '11800.00'), // far later: alone
        b('e', 'v2', '2026-10-02', '11800.00'), // other vendor
        b('f', 'v1', '2026-10-02', '11800.01'), // other amount
        b('g', 'v1', '2026-10-03', '0'),
        b('h', 'v1', '2026-10-03', '0'),
      ],
      7,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(groups[0].spanDays).toBe(10);
    expect(groups[0].amount.toFixed(2)).toBe('11800.00');
  });

  it('a zero window only matches the same day', () => {
    expect(findDuplicates([b('a', 'v', '2026-10-01', '5'), b('b', 'v', '2026-10-02', '5')], 0)).toHaveLength(0);
    expect(findDuplicates([b('a', 'v', '2026-10-01', '5'), b('b', 'v', '2026-10-01', '5')], 0)).toHaveLength(1);
  });
});

describe('unusual journals', () => {
  const history = ['10000', '12000', '8000', '11000', '9000', '10000']; // median 10000
  const params = { multiple: new D(5), minAmount: new D(40000), backdatedDays: 30 };
  it('flags size against the median and late posting, with reasons', () => {
    const out = unusualJournals(
      [
        { id: 'big', date: '2026-10-10', postedOn: '2026-10-10', total: '60000' },
        { id: 'late', date: '2026-08-01', postedOn: '2026-10-01', total: '5000' },
        { id: 'both', date: '2026-08-01', postedOn: '2026-09-15', total: '250000' },
        { id: 'fine', date: '2026-10-10', postedOn: '2026-10-11', total: '45000' },
      ],
      history,
      params,
    );
    expect(out.map((o) => o.id)).toEqual(['big', 'late', 'both']);
    expect(out[0].reasons).toEqual([{ code: 'LARGE', text: '6.0 times the usual manual journal' }]);
    expect(out[0].typical!.toFixed()).toBe('10000');
    expect(out[1].reasons).toEqual([{ code: 'BACKDATED', text: 'Posted 61 days after its date' }]);
    expect(out[2].reasons.map((r) => r.code)).toEqual(['LARGE', 'BACKDATED']);
  });

  it('does not judge size below the minimum or without enough history', () => {
    expect(unusualJournals([{ id: 'x', date: '2026-10-10', postedOn: '2026-10-10', total: '39999' }], history, params)).toHaveLength(0);
    const out = unusualJournals([{ id: 'x', date: '2026-10-10', postedOn: '2026-10-10', total: '9000000' }], ['1', '2', '3', '4'], params);
    expect(out).toHaveLength(0);
  });
});

describe('missed recurring billing', () => {
  const r = (contactId: string, month: string, amount: string) => ({ contactId, month, amount });
  it('finds customers billed every month before but not this month', () => {
    const rows = [
      r('acme', '2026-07', '50000'),
      r('acme', '2026-08', '50000'),
      r('acme', '2026-09', '55000'),
      r('beta', '2026-07', '20000'),
      r('beta', '2026-09', '20000'), // gap in August
      r('gamma', '2026-07', '10000'),
      r('gamma', '2026-08', '10000'),
      r('gamma', '2026-09', '10000'),
      r('gamma', '2026-10', '10000'), // billed this month
      r('delta', '2026-07', '30000'),
      r('delta', '2026-08', '30000'),
      r('delta', '2026-09', '-30000'), // credited away: not billed
    ];
    const out = missedRecurringBilling(rows, '2026-10', 3);
    expect(out.map((o) => o.contactId)).toEqual(['acme']);
    expect(out[0].typical.toFixed()).toBe('50000');
    expect(out[0].history.map((h) => [h.month, h.amount.toFixed()])).toEqual([
      ['2026-07', '50000'],
      ['2026-08', '50000'],
      ['2026-09', '55000'],
    ]);
  });

  it('crosses year ends', () => {
    const out = missedRecurringBilling([r('a', '2025-11', '1'), r('a', '2025-12', '1')], '2026-01', 2);
    expect(out).toHaveLength(1);
  });
});

describe('budget overruns', () => {
  it('needs both the share and the amount, and counts unbudgeted spending', () => {
    const out = budgetOverruns(
      [
        { accountId: 'rent', budget: '100000', actual: '115000' }, // 15 %, 15000
        { accountId: 'travel', budget: '10000', actual: '14000' }, // 40 %, but 4000 < 10000
        { accountId: 'fees', budget: '500000', actual: '530000' }, // 6 %
        { accountId: 'new', budget: '0', actual: '12000' }, // no budget
        { accountId: 'small', budget: '0', actual: '900' },
        { accountId: 'under', budget: '50000', actual: '20000' },
      ],
      { percent: new D(10), minAmount: new D(10000) },
    );
    expect(out.map((o) => [o.accountId, o.over.toFixed(), o.percent])).toEqual([
      ['rent', '15000', '15.0'],
      ['new', '12000', null],
    ]);
  });
});

describe('overdue receivables', () => {
  it('groups by customer, above the days and amount', () => {
    const i = (id: string, contactId: string, dueDate: string, open: string) => ({ id, contactId, number: id, dueDate, open });
    const out = overdueByCustomer(
      [i('INV-1', 'a', '2026-07-01', '30000'), i('INV-2', 'a', '2026-09-20', '20000'), i('INV-3', 'a', '2026-10-25', '9000'), i('INV-4', 'b', '2026-09-01', '500'), i('INV-5', 'c', '2026-08-01', '0')],
      '2026-11-01',
      30,
      new D(1000),
    );
    expect(out).toHaveLength(1);
    expect(out[0].total.toFixed()).toBe('50000');
    expect(out[0].oldestDays).toBe(123);
    expect(out[0].invoices.map((x) => [x.id, x.daysOverdue])).toEqual([
      ['INV-1', 123],
      ['INV-2', 42],
    ]);
  });
});

describe('keeping alerts in step', () => {
  it('opens, refreshes, reopens and clears; dismissed alerts stay dismissed', () => {
    const existing = [
      { id: '1', rule: 'DUPLICATE_BILL', fingerprint: 'x', status: 'OPEN' as const },
      { id: '2', rule: 'DUPLICATE_BILL', fingerprint: 'y', status: 'ACKNOWLEDGED' as const },
      { id: '3', rule: 'DUPLICATE_BILL', fingerprint: 'z', status: 'DISMISSED' as const },
      { id: '4', rule: 'DUPLICATE_BILL', fingerprint: 'w', status: 'CLEARED' as const },
      { id: '5', rule: 'DUPLICATE_BILL', fingerprint: 'v', status: 'DISMISSED' as const },
      { id: '6', rule: 'UNUSUAL_JOURNAL', fingerprint: 'j', status: 'OPEN' as const },
    ];
    const found = [
      { rule: 'DUPLICATE_BILL', fingerprint: 'x' },
      { rule: 'DUPLICATE_BILL', fingerprint: 'z' },
      { rule: 'DUPLICATE_BILL', fingerprint: 'w' },
      { rule: 'DUPLICATE_BILL', fingerprint: 'new' },
      { rule: 'DUPLICATE_BILL', fingerprint: 'new' },
    ];
    const s = syncAlerts(existing, found, ['DUPLICATE_BILL']);
    expect(s.create).toEqual([{ rule: 'DUPLICATE_BILL', fingerprint: 'new' }]);
    expect(s.refresh).toEqual([
      { id: '1', fingerprint: 'x', reopen: false },
      { id: '3', fingerprint: 'z', reopen: false },
      { id: '4', fingerprint: 'w', reopen: true },
    ]);
    // 2 (acknowledged, gone) clears; 5 stays dismissed; 6 belongs to a rule that did not run.
    expect(s.clear).toEqual(['2']);
  });
});

describe('alert priority', () => {
  const base = { severity: 'CRITICAL' as const, status: 'OPEN' as const, amount: null, monthlyRevenue: '100000', firstSeenAt: '2026-11-01T10:00:00Z', reopenCount: 0, today: '2026-11-01' };
  it('scores severity, money at stake against revenue, age and recurrence, and explains it', () => {
    expect(alertPriority(base)).toEqual({ score: 60, band: 'HIGH', reasons: ['Critical (60)'] });
    const big = alertPriority({ ...base, amount: '150000', firstSeenAt: '2026-10-20T00:00:00Z', reopenCount: 1 });
    expect(big.score).toBe(60 + 25 + 4 + 5);
    expect(big.band).toBe('URGENT');
    expect(big.reasons).toEqual(['Critical (60)', 'Amount at stake is more than a month of revenue (25)', 'Came back 1 time after it cleared or was dismissed (5)', 'Open for 12 days (4)']);
    expect(alertPriority({ ...base, severity: 'WARNING', amount: '30000' }).reasons).toEqual(['Warning (35)', 'Amount at stake is 30% of a month of revenue (15)']);
    expect(alertPriority({ ...base, severity: 'INFO', amount: '1000', monthlyRevenue: null })).toMatchObject({ score: 18, band: 'LOW' });
  });
  it('lowers acknowledged alerts and zeroes closed ones', () => {
    expect(alertPriority({ ...base, status: 'ACKNOWLEDGED' })).toMatchObject({ score: 45, band: 'HIGH' });
    expect(alertPriority({ ...base, status: 'CLEARED' })).toEqual({ score: 0, band: 'LOW', reasons: ['Cleared: no longer found'] });
  });
  it('decides which alerts become tasks', () => {
    expect([notifies('CRITICAL', 'CRITICAL'), notifies('WARNING', 'CRITICAL'), notifies('WARNING', 'WARNING'), notifies('INFO', 'WARNING'), notifies('CRITICAL', 'OFF')]).toEqual([true, false, true, false, false]);
  });
});
