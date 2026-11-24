import { describe, expect, it } from 'vitest';
import { portalDashboard, portalMonths } from '../src/portal-dashboard';

describe('portal months', () => {
  it('lists the twelve months up to this one, across a year end', () => {
    expect(portalMonths('2026-03-15')).toEqual(['2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
  });
});

describe('portal dashboard', () => {
  const today = '2026-11-24';
  const d = portalDashboard({
    currency: 'INR',
    today,
    items: [
      { type: 'charge', currency: 'INR', open: '1000.00', dueDate: '2026-11-30', issueDate: '2026-11-01' },
      { type: 'charge', currency: 'INR', open: '500.00', dueDate: '2026-11-30', issueDate: '2026-11-02' },
      { type: 'charge', currency: 'INR', open: '2000.00', dueDate: '2027-01-10', issueDate: '2026-11-10' },
      { type: 'charge', currency: 'INR', open: '300.00', dueDate: '2026-10-10', issueDate: '2026-09-10' },
      { type: 'charge', currency: 'INR', open: '700.00', dueDate: null, issueDate: '2026-07-01' },
      { type: 'credit', currency: 'INR', open: '100.00', dueDate: null, issueDate: '2026-11-05' },
      { type: 'charge', currency: 'USD', open: '50.00', dueDate: '2026-10-01', issueDate: '2026-09-01' },
    ],
    documents: [
      { kind: 'CHARGE', status: 'POSTED', currency: 'INR', issueDate: '2026-11-01', total: '1000.00' },
      { kind: 'CHARGE', status: 'POSTED', currency: 'INR', issueDate: '2026-11-02', total: '500.00' },
      { kind: 'CREDIT', status: 'POSTED', currency: 'INR', issueDate: '2026-11-05', total: '100.00' },
      { kind: 'CHARGE', status: 'VOID', currency: 'INR', issueDate: '2026-11-06', total: '999.00' },
      { kind: 'CHARGE', status: 'POSTED', currency: 'INR', issueDate: '2025-11-30', total: '4000.00' },
      { kind: 'CHARGE', status: 'POSTED', currency: 'INR', issueDate: '2025-12-01', total: '800.00' },
      { kind: 'CHARGE', status: 'POSTED', currency: 'USD', issueDate: '2026-09-01', total: '50.00' },
    ],
    payments: [
      { status: 'POSTED', currency: 'INR', date: '2026-10-15', amount: '600.00' },
      { status: 'VOID', currency: 'INR', date: '2026-10-16', amount: '600.00' },
      { status: 'POSTED', currency: 'INR', date: '2025-12-01', amount: '800.00' },
    ],
  });

  it('ages what is open in the currency, an item without a due date by its issue date', () => {
    expect(d.aging.total).toBe('4500.00');
    expect(d.aging.overdue).toBe('1000.00');
    expect(d.aging.buckets.map((b) => `${b.bucket} ${b.amount} ${b.count}`)).toEqual(['CURRENT 3500.00 3', 'DAYS_1_30 0.00 0', 'DAYS_31_60 300.00 1', 'DAYS_61_90 0.00 0', 'OVER_90 700.00 1']);
  });

  it('names the next due date with everything due on it, and what falls due within 30 days', () => {
    expect(d.nextDue).toEqual({ date: '2026-11-30', amount: '1500.00', items: 2 });
    expect(d.dueIn30Days).toBe('1500.00');
  });

  it('totals twelve months of invoices less credits and payments, leaving out voids and older months', () => {
    expect(d.months).toHaveLength(12);
    expect(d.months[0]).toEqual({ month: '2025-12', invoiced: '800.00', paid: '800.00' });
    expect(d.months.at(-1)).toEqual({ month: '2026-11', invoiced: '1400.00', paid: '0.00' });
    expect(d.lastTwelveMonths).toEqual({ invoiced: '2200.00', paid: '1400.00' });
  });

  it('is empty when nothing is open', () => {
    const e = portalDashboard({ currency: 'INR', today, items: [], documents: [], payments: [] });
    expect(e.nextDue).toBeNull();
    expect(e.aging.total).toBe('0.00');
    expect(e.lastTwelveMonths).toEqual({ invoiced: '0.00', paid: '0.00' });
  });
});
