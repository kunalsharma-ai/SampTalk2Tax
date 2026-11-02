import { describe, expect, it } from 'vitest';
import { JournalValidationError, PostingAccount, buildReversalLines, sum, validateJournal } from '../src';

const accounts = new Map<string, PostingAccount>([
  ['cash', { id: 'cash', code: '1110', type: 'ASSET', isPostable: true, isActive: true }],
  ['ar', { id: 'ar', code: '1200', type: 'ASSET', isPostable: true, isActive: true }],
  ['rev', { id: 'rev', code: '4100', type: 'REVENUE', isPostable: true, isActive: true }],
  ['fx', { id: 'fx', code: '7200', type: 'EXPENSE', isPostable: true, isActive: true }],
  ['hdr', { id: 'hdr', code: '1000', type: 'ASSET', isPostable: false, isActive: true }],
  ['old', { id: 'old', code: '1999', type: 'ASSET', isPostable: true, isActive: false }],
]);
const ctx = { functionalCurrency: 'INR', accounts };

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof JournalValidationError) return e.issues;
    throw e;
  }
  return [];
}

describe('validateJournal', () => {
  it('accepts a simple balanced entry', () => {
    const j = validateJournal(
      [
        { accountId: 'cash', debit: '1180.00' },
        { accountId: 'rev', credit: '1180.00' },
      ],
      ctx,
    );
    expect(j.totalFunctionalDebit.toFixed(2)).toBe('1180.00');
    expect(j.totalFunctionalCredit.equals(j.totalFunctionalDebit)).toBe(true);
  });

  it('rejects an unbalanced entry', () => {
    const issues = issuesOf(() =>
      validateJournal(
        [
          { accountId: 'cash', debit: '100.00' },
          { accountId: 'rev', credit: '99.99' },
        ],
        ctx,
      ),
    );
    expect(issues.join()).toMatch(/does not balance/);
  });

  it('rejects single-line, zero, double-sided and negative lines', () => {
    expect(issuesOf(() => validateJournal([{ accountId: 'cash', debit: '1' }], ctx)).join()).toMatch(/at least two lines/);
    const issues = issuesOf(() =>
      validateJournal(
        [
          { accountId: 'cash', debit: '0' },
          { accountId: 'ar', debit: '5', credit: '5' },
          { accountId: 'rev', credit: '-5' },
        ],
        ctx,
      ),
    );
    expect(issues.join()).toMatch(/Line 1: either debit or credit/);
    expect(issues.join()).toMatch(/Line 2: a line cannot have both/);
    expect(issues.join()).toMatch(/Line 3 credit must not be negative/);
  });

  it('rejects header, inactive and unknown accounts', () => {
    const issues = issuesOf(() =>
      validateJournal(
        [
          { accountId: 'hdr', debit: '10' },
          { accountId: 'old', debit: '10' },
          { accountId: 'nope', credit: '20' },
        ],
        ctx,
      ),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/header account/),
        expect.stringMatching(/inactive/),
        expect.stringMatching(/account not found/),
      ]),
    );
  });

  it('rejects precision beyond the currency minor unit', () => {
    const issues = issuesOf(() =>
      validateJournal(
        [
          { accountId: 'cash', debit: '10.005' },
          { accountId: 'rev', credit: '10.005' },
        ],
        ctx,
      ),
    );
    expect(issues.join()).toMatch(/more decimal places/);
  });

  it('converts foreign-currency lines at the given rate and balances in functional currency', () => {
    const j = validateJournal(
      [
        { accountId: 'ar', debit: '100.00', currency: 'USD', exchangeRate: '83.2512' },
        { accountId: 'rev', credit: '8325.12' },
      ],
      ctx,
    );
    expect(j.lines[0].functionalDebit.toFixed(2)).toBe('8325.12');
  });

  it('requires an exchange rate for foreign currency and rate 1 for functional', () => {
    expect(
      issuesOf(() =>
        validateJournal(
          [
            { accountId: 'ar', debit: '100.00', currency: 'USD' },
            { accountId: 'rev', credit: '100.00' },
          ],
          ctx,
        ),
      ).join(),
    ).toMatch(/exchange rate is required/);
    expect(
      issuesOf(() =>
        validateJournal(
          [
            { accountId: 'cash', debit: '1', exchangeRate: '2' },
            { accountId: 'rev', credit: '1' },
          ],
          ctx,
        ),
      ).join(),
    ).toMatch(/must be 1/);
  });

  it('flags FX rounding differences and accepts an explicit rounding line', () => {
    const lines = [
      { accountId: 'ar', debit: '0.01', currency: 'USD', exchangeRate: '83.333' },
      { accountId: 'ar', debit: '0.01', currency: 'USD', exchangeRate: '83.333' },
      { accountId: 'ar', debit: '0.01', currency: 'USD', exchangeRate: '83.333' },
      { accountId: 'rev', credit: '2.50' },
    ];
    // each line converts to 0.83 → 2.49 vs 2.50
    expect(issuesOf(() => validateJournal(lines, ctx)).join()).toMatch(/rounding line/);
    const ok = validateJournal([...lines, { accountId: 'fx', debit: '0.01' }], ctx);
    expect(ok.totalFunctionalDebit.toFixed(2)).toBe('2.50');
  });

  it('builds a reversal that nets the original to zero', () => {
    const original = validateJournal(
      [
        { accountId: 'ar', debit: '100.00', currency: 'USD', exchangeRate: '83.25' },
        { accountId: 'rev', credit: '8325.00' },
      ],
      ctx,
    );
    const reversal = validateJournal(
      buildReversalLines(
        original.lines.map((l) => ({
          accountId: l.accountId,
          currency: l.currency,
          exchangeRate: l.exchangeRate.toFixed(),
          debit: l.debit.toFixed(),
          credit: l.credit.toFixed(),
        })),
      ),
      ctx,
    );
    const net = sum([...original.lines, ...reversal.lines].map((l) => l.functionalDebit.minus(l.functionalCredit)));
    expect(net.isZero()).toBe(true);
    for (const acc of ['ar', 'rev']) {
      const perAccount = sum(
        [...original.lines, ...reversal.lines].filter((l) => l.accountId === acc).map((l) => l.functionalDebit.minus(l.functionalCredit)),
      );
      expect(perAccount.isZero()).toBe(true);
    }
  });
});

describe('department and project tags', () => {
  it('keeps them on validated lines and on reversals', () => {
    const j = validateJournal(
      [
        { accountId: 'cash', debit: '500.00' },
        { accountId: 'rev', credit: '500.00', departmentId: 'd-sales', projectId: 'p-portal' },
      ],
      ctx,
    );
    expect(j.lines.map((l) => [l.departmentId, l.projectId])).toEqual([[null, null], ['d-sales', 'p-portal']]);
    const rev = buildReversalLines([{ accountId: 'rev', currency: 'INR', exchangeRate: '1', debit: '0.00', credit: '500.00', departmentId: 'd-sales', projectId: 'p-portal' }]);
    expect(rev[0]).toMatchObject({ debit: '500.00', departmentId: 'd-sales', projectId: 'p-portal' });
  });
});
