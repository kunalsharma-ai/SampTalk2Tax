import { describe, expect, it } from 'vitest';
import { disputeAge, disputeIssues, disputeRef, disputeSummary, resolutionIssues } from '../src/disputes';

const T = '2026-11-09';
describe('invoice disputes', () => {
  it('numbers disputes', () => {
    expect(disputeRef(7)).toBe('DS-0007');
  });

  it('checks the disputed amount against what is still due', () => {
    expect(disputeIssues({ amount: '500', open: '1180', currency: 'INR', description: 'Wrong rate', today: T })).toEqual([]);
    expect(disputeIssues({ amount: '1180.01', open: '1180', currency: 'INR', description: 'x', today: T })).toEqual(['The disputed amount is more than the 1180.00 INR still due on the invoice']);
    expect(disputeIssues({ amount: '0', open: '10', currency: 'INR', description: 'x', today: T })).toEqual(['The disputed amount must be more than zero']);
    expect(disputeIssues({ amount: '1.005', open: '10', currency: 'INR', description: 'x', today: T })[0]).toMatch(/more decimals/);
    expect(disputeIssues({ amount: 'abc', open: '10', currency: 'INR', description: ' ', today: T })).toEqual(['Say what the customer disputes', 'abc is not an amount']);
    expect(disputeIssues({ amount: '1', open: '10', currency: 'INR', description: 'x', targetDate: '2026-11-08', today: T })).toEqual(['The target date cannot be in the past']);
  });

  it('checks a resolution', () => {
    expect(resolutionIssues({ outcome: 'WITHDRAWN', note: 'Customer found the delivery' })).toEqual([]);
    expect(resolutionIssues({ outcome: 'CREDIT_NOTE', note: 'Agreed', creditNote: null })).toEqual(['Choose the credit note that settles the dispute']);
    expect(resolutionIssues({ outcome: 'CREDIT_NOTE', note: 'Agreed', creditNote: { status: 'DRAFT', contactMatches: false, currencyMatches: true } })).toEqual(['The credit note must be posted', 'The credit note is for a different customer']);
    expect(resolutionIssues({ outcome: 'CUSTOMER_PAYS', note: '', creditNote: { status: 'POSTED', contactMatches: true, currencyMatches: true } })).toEqual(['Say how the dispute was settled', 'Only a credit-note outcome takes a credit note']);
  });

  it('sums open and resolved disputes', () => {
    expect(disputeAge('2026-11-01', null, T)).toBe(8);
    const s = disputeSummary(
      [
        { status: 'OPEN', amount: '100.50', openedOn: '2026-10-30', resolvedOn: null, targetDate: '2026-11-05', outcome: null },
        { status: 'OPEN', amount: '200', openedOn: '2026-11-08', resolvedOn: null, targetDate: null, outcome: null },
        { status: 'RESOLVED', amount: '50', openedOn: '2026-10-01', resolvedOn: '2026-10-11', targetDate: null, outcome: 'CREDIT_NOTE' },
        { status: 'RESOLVED', amount: '50', openedOn: '2026-10-01', resolvedOn: '2026-10-06', targetDate: null, outcome: 'WITHDRAWN' },
      ],
      T,
      'INR',
    );
    expect(s).toMatchObject({ open: 2, openAmount: '300.50', pastTarget: 1, oldestOpenDays: 10, resolved: 2, averageDaysToResolve: 8 });
    expect(s.outcomes).toEqual({ CREDIT_NOTE: 1, CUSTOMER_PAYS: 0, WRITTEN_OFF: 0, WITHDRAWN: 1 });
    expect(disputeSummary([], T, 'INR')).toMatchObject({ open: 0, openAmount: '0.00', oldestOpenDays: null, averageDaysToResolve: null });
  });
});
