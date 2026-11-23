import { describe, expect, it } from 'vitest';
import { missingClaimReceipts } from '../src';

const line = (lineNo: number, amount: string, extra: { isAllowance?: boolean; categoryNeedsReceipt?: boolean } = {}) => ({ lineNo, amount, isAllowance: false, categoryNeedsReceipt: false, ...extra });
const claim = (id: string, over: object) => ({ id, number: `EXP-${id}`, title: id, claimantId: 'u1', status: 'APPROVED', submittedOn: '2026-11-01', receiptCount: 0, lines: [line(1, '100.00')], ...over });

describe('missing receipt detection', () => {
  it('finds live claims with receipt lines and no receipt, with why each matters', () => {
    const r = missingClaimReceipts(
      [
        claim('a', { lines: [line(1, '600.00'), line(2, '0.10')] }),
        claim('b', { lines: [line(1, '200.00', { categoryNeedsReceipt: true })], submittedOn: '2026-10-20' }),
        claim('c', { receiptCount: 1 }),
        claim('d', { status: 'DRAFT' }),
        claim('e', { lines: [line(1, '900.00', { isAllowance: true })] }),
        claim('f', { lines: [line(1, '50.00')], claimantId: 'u2', submittedOn: '2026-10-01' }),
        claim('g', { lines: [line(1, '700.00', { categoryNeedsReceipt: true })], status: 'REIMBURSED' }),
      ],
      { receiptAbove: '500', today: '2026-11-23', scale: 2 },
    );
    expect(r.items.map((x) => [x.id, x.reasons, x.amount, x.daysWaiting])).toEqual([
      ['a', ['POLICY'], '600.10', 22],
      ['g', ['POLICY', 'CATEGORY'], '700.00', 22],
      ['b', ['CATEGORY'], '200.00', 34],
      ['f', ['NONE'], '50.00', 53],
    ]);
    expect(r.checked).toBe(5);
    expect(r).toMatchObject({ missing: 4, required: 3, amount: '1550.10', requiredAmount: '1500.10' });
    expect(r.byClaimant).toEqual([
      { claimantId: 'u1', claims: 3, amount: '1500.10', required: 3 },
      { claimantId: 'u2', claims: 1, amount: '50.00', required: 0 },
    ]);
  });

  it('only counts the receipt lines, and without a policy amount nothing is required by policy', () => {
    const r = missingClaimReceipts([claim('a', { lines: [line(1, '800.00'), line(2, '300.00', { isAllowance: true })] })], { receiptAbove: null, today: '2026-11-01', scale: 0 });
    expect(r.items[0]).toMatchObject({ reasons: ['NONE'], amount: '800', lineNos: [1], daysWaiting: 0 });
  });
});
