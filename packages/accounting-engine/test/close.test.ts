import { describe, expect, it } from 'vitest';
import { checkAdjustment, closeContextForModel, closeReadiness, CloseFacts, CloseReviewContext, evaluateClose, parseAdjustment } from '../src/close';

const facts = (over: Partial<CloseFacts> = {}): CloseFacts => ({
  currency: 'INR',
  period: { name: 'Oct 2026', startDate: '2026-10-01', endDate: '2026-10-31' },
  draftJournals: 0,
  draftDocuments: 0,
  unmatchedBankLines: [],
  unreconciledBankAccounts: [],
  pendingApprovals: 0,
  submittedExpenseClaims: 0,
  payroll: null,
  depreciation: { fixedAssets: '0', postedThisMonth: '0' },
  negativeCash: [],
  aiWaiting: { bankSuggestions: 0, adjustments: 0 },
  trialBalance: { debit: '1500.00', credit: '1500.00' },
  earlierOpenPeriods: [],
  ...over,
});

describe('month-end checklist', () => {
  it('passes a clean month and lets it close without a note', () => {
    const checks = evaluateClose(facts());
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(closeReadiness(checks, null)).toMatchObject({ blocking: 0, warnings: 0, canClose: true, noteRequired: false });
  });

  it('blocks on draft journals, unmatched bank lines and an unbalanced trial balance', () => {
    const checks = evaluateClose(facts({ draftJournals: 2, unmatchedBankLines: [{ code: '1120', name: 'Bank', count: 3 }], trialBalance: { debit: '100.00', credit: '99.00' } }));
    const failing = checks.filter((c) => !c.ok);
    expect(failing.map((c) => [c.key, c.severity])).toEqual([
      ['DRAFT_JOURNALS', 'BLOCKING'],
      ['UNMATCHED_BANK_LINES', 'BLOCKING'],
      ['TRIAL_BALANCE', 'BLOCKING'],
    ]);
    expect(failing[1].detail).toBe('3 bank lines not matched or excluded: 1120 Bank (3)');
    expect(failing[2].detail).toBe('Debits ₹100.00 and credits ₹99.00 differ by ₹1.00');
    expect(closeReadiness(checks, 'a long enough note')).toMatchObject({ canClose: false, reason: '3 blocking checks not passed' });
  });

  it('needs a note to close with warnings open', () => {
    const checks = evaluateClose(facts({ payroll: { posted: false, drafts: 1 }, depreciation: { fixedAssets: '250000', postedThisMonth: '0' }, negativeCash: [{ code: '1110', name: 'Cash', balance: '-500' }], earlierOpenPeriods: ['Sep 2026'] }));
    expect(checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([
      'The pay run for Oct 2026 is still a draft',
      'Fixed assets of ₹2,50,000.00 but no depreciation posted in the month',
      'Below zero at the month end: 1110 Cash -₹500.00',
      'Still open: Sep 2026',
    ]);
    expect(closeReadiness(checks, 'ok')).toMatchObject({ canClose: false, noteRequired: true });
    expect(closeReadiness(checks, 'Depreciation is booked quarterly')).toMatchObject({ canClose: true });
  });
});

const ctx: CloseReviewContext = {
  currency: 'INR',
  org: 'Acme',
  period: { name: 'Oct 2026', startDate: '2026-10-01', endDate: '2026-10-31' },
  nextPeriod: { name: 'Nov 2026', startDate: '2026-11-01', open: true },
  checks: [{ label: 'No draft journals in the month', ok: true, detail: 'Every journal dated in the month is posted' }],
  accounts: [
    { code: '6200', name: 'Rent', type: 'EXPENSE', movement: '0', priorAverage: '45000', monthsActive: 3, closingBalance: '135000' },
    { code: '1400', name: 'Prepaid Expenses', type: 'ASSET', movement: '0', priorAverage: '0', monthsActive: 0, closingBalance: '120000' },
  ],
  allowed: [
    { code: '6200', id: 'a-rent', name: 'Rent', type: 'EXPENSE' },
    { code: '2200', id: 'a-accr', name: 'Accrued Liabilities', type: 'LIABILITY' },
    { code: '1400', id: 'a-pre', name: 'Prepaid Expenses', type: 'ASSET' },
  ],
};

describe('AI adjusting entries', () => {
  it('resolves a balanced accrual that reverses next month', () => {
    const { checks, resolved } = checkAdjustment(ctx, { description: 'Accrue October rent', reason: 'Rent posted every month but not October', confidence: 'HIGH', reverseNextPeriod: true, lines: [{ accountCode: '6200', debit: '45000.00' }, { accountCode: '2200', credit: '45000' }] });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(resolved).toEqual({
      date: '2026-10-31',
      description: 'Accrue October rent',
      total: '45000.00',
      reverseOn: '2026-11-01',
      lines: [
        { accountId: 'a-rent', accountCode: '6200', accountName: 'Rent', debit: '45000.00', credit: '0.00', description: '' },
        { accountId: 'a-accr', accountCode: '2200', accountName: 'Accrued Liabilities', debit: '0.00', credit: '45000.00', description: '' },
      ],
    });
    expect(checks.at(-1)!.label).toBe('Reversed on 1 Nov 2026, the first day of Nov 2026');
  });

  it('refuses accounts it was not given, lines with both sides, bad amounts and unbalanced entries', () => {
    const { checks, resolved } = checkAdjustment(ctx, { description: 'x', reason: 'y', confidence: 'LOW', reverseNextPeriod: false, lines: [{ accountCode: '1120', debit: '10' }, { accountCode: '6200', debit: '10', credit: '10' }, { accountCode: '2200', credit: '1,000' }, { accountCode: '1400', credit: '5' }] });
    expect(resolved).toBeNull();
    expect(checks.filter((c) => !c.ok).map((c) => c.label)).toEqual([
      'Accounts it may not use: 1120',
      '6200: a line is either a debit or a credit; 2200: "1,000" is not an amount',
      'Debits ₹10.00 and credits ₹5.00 do not balance',
    ]);
  });

  it('cannot reverse into a locked or missing period', () => {
    const entry = { description: 'Accrue', reason: 'r', confidence: 'MEDIUM' as const, reverseNextPeriod: true, lines: [{ accountCode: '6200', debit: '1' }, { accountCode: '2200', credit: '1' }] };
    expect(checkAdjustment({ ...ctx, nextPeriod: { ...ctx.nextPeriod!, open: false } }, entry).checks.at(-1)).toEqual({ ok: false, label: 'Nov 2026 is locked, so the reversal cannot be posted' });
    expect(checkAdjustment({ ...ctx, nextPeriod: null }, entry).resolved).toBeNull();
  });

  it('shows the model the month, accounts usually posted to that are empty, and what it may use', () => {
    const t = closeContextForModel(ctx);
    expect(t).toContain('- 6200 Rent (expense): this month ₹0.00, average of the 3 months before ₹45,000.00, posted to in 3 of those 3');
    expect(t).toContain('Posted to in each of the 3 months before but nothing this month: 6200 Rent.');
    expect(t).toContain('closing balance ₹1,20,000.00');
    expect(t).toContain('- 2200 Accrued Liabilities (liability)');
    expect(t).not.toContain('a-rent');
  });

  it('parses only complete proposals', () => {
    expect(parseAdjustment({ description: 'd', reason: 'r', confidence: 'HIGH', lines: [{ accountCode: '6200', debit: 10 }] })).toMatchObject({ reverseNextPeriod: false, lines: [{ accountCode: '6200', debit: '10' }] });
    expect(parseAdjustment({ description: 'd', reason: '', confidence: 'HIGH', lines: [] })).toBeNull();
    expect(parseAdjustment({ description: 'd', reason: 'r', confidence: 'SURE', lines: [] })).toBeNull();
  });
});
