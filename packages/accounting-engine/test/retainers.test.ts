import { describe, expect, it } from 'vitest';
import { drawdownIssues, planDrawdown, retainerIssues, retainerRef, retainerState, topUpDue } from '../src';

describe('retainers', () => {
  it('are held, due a top-up below the minimum, or empty', () => {
    const r = { status: 'ACTIVE' as const, amount: '100000', minimumBalance: '25000' };
    expect(retainerRef(3)).toBe('RT-0003');
    expect(retainerState(r, '60000')).toBe('HEALTHY');
    expect(topUpDue(r, '60000')).toBe('0');
    expect(retainerState(r, '20000')).toBe('LOW');
    expect(topUpDue(r, '20000')).toBe('80000');
    expect(retainerState(r, '0')).toBe('EMPTY');
    expect(topUpDue(r, '0')).toBe('100000');
    expect(retainerState({ ...r, status: 'CLOSED' }, '0')).toBe('CLOSED');
    expect(topUpDue({ ...r, minimumBalance: '0' }, '0')).toBe('0');
  });

  it('checks the terms', () => {
    expect(retainerIssues({ name: 'Monthly advisory', amount: '100000', minimumBalance: '25000' })).toEqual([]);
    expect(retainerIssues({ name: ' ', amount: '0', minimumBalance: '-1' })).toEqual(['Give the retainer a name', 'The agreed amount must be above zero', 'The minimum balance cannot be negative']);
    expect(retainerIssues({ name: 'X', amount: '100', minimumBalance: '150' })).toEqual(['The minimum balance cannot be more than the agreed amount']);
    expect(retainerIssues({ name: 'X', amount: '100.001', minimumBalance: '0' })).toEqual(['Use at most 2 decimal places']);
  });

  it('draws down the oldest receipts first, across invoices', () => {
    const receipts = [
      { id: 'r2', date: '2026-10-01', unallocated: '30000' },
      { id: 'r1', date: '2026-09-01', unallocated: '10000' },
    ];
    const invoices = [
      { id: 'b', dueDate: '2026-10-20', issueDate: '2026-10-05', open: '25000' },
      { id: 'a', dueDate: '2026-10-10', issueDate: '2026-09-25', open: '20000' },
    ];
    expect(planDrawdown(receipts, invoices, true)).toEqual([
      { paymentId: 'r1', documentId: 'a', amount: '10000' },
      { paymentId: 'r2', documentId: 'a', amount: '10000' },
      { paymentId: 'r2', documentId: 'b', amount: '20000' },
    ]);
    expect(planDrawdown(receipts, [{ ...invoices[0]!, amount: '5000' }])).toEqual([{ paymentId: 'r1', documentId: 'b', amount: '5000' }]);
  });

  it('refuses paying more than held or owed', () => {
    expect(drawdownIssues('1000', [{ number: 'INV-000001', open: '800', amount: '900' }])).toEqual(['INV-000001: only 800 is still owed']);
    expect(drawdownIssues('1000', [{ number: 'INV-000001', open: '800', amount: '800' }, { number: 'INV-000002', open: '500', amount: '300' }])).toEqual(['The retainer holds 1000; it cannot pay 1100']);
    expect(drawdownIssues('1000', [])).toEqual(['Choose at least one invoice to pay from the retainer']);
  });
});
