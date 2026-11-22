import { describe, expect, it } from 'vitest';
import { addDays } from '../src/documents';
import { formatDateText } from '../src/workflows';
import { expenseRisk, normaliseMerchant, type ExpenseRiskClaim, type ExpenseRiskLine } from '../src/expense-risk';

// A fixed Wednesday, so Sundays are known.
const T = '2026-11-18';
const d = (n: number) => addDays(T, -n);
const money = (a: string, c: string) => `${c} ${a}`;
let seq = 0;
const line = (lineNo: number, date: string, amount: string, more: Partial<ExpenseRiskLine> = {}): ExpenseRiskLine => ({ lineNo, date, accountId: 'meals', accountLabel: '6600 · Meals', merchant: null, amount, ...more });
const claim = (claimantId: string, submittedOn: string, lines: ExpenseRiskLine[], more: Partial<ExpenseRiskClaim> = {}): ExpenseRiskClaim => ({
  id: `c${++seq}`,
  number: `EXP-${String(seq).padStart(4, '0')}`,
  claimantId,
  claimantName: claimantId === 'asha' ? 'Asha' : 'Ravi',
  status: 'APPROVED',
  submittedOn,
  currency: 'INR',
  total: lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2), // not money: fixture totals only
  receiptCount: 1,
  lines,
  ...more,
});

describe('expense risk', () => {
  it('normalises merchants', () => {
    expect(normaliseMerchant('  Cafe-Coffee DAY, MG Rd. ')).toBe('cafe coffee day mg rd');
    expect(normaliseMerchant(null)).toBe('');
  });

  it('finds duplicates across claims and people, old receipts, missing receipts, Sundays and round amounts', () => {
    const first = claim('asha', d(20), [line(1, d(22), '845.50', { merchant: 'Cafe Coffee Day' })]);
    const second = claim('ravi', d(5), [line(1, d(22), '845.50', { merchant: 'CAFE COFFEE DAY' }), line(2, d(81), '640.25')], { status: 'SUBMITTED', receiptCount: 0 });
    const big = claim('ravi', d(4), [line(1, d(4), '2500.00', { accountId: 'travel', accountLabel: '6400 · Travel' }), line(2, d(3), '3100.00', { accountId: 'travel', accountLabel: '6400 · Travel' })], { receiptCount: 0 });
    const draft = claim('asha', d(2), [line(1, d(22), '845.50', { merchant: 'Cafe Coffee Day' })], { status: 'DRAFT' });
    const r = expenseRisk([first, second, big, draft], { from: d(30), asOf: T, limits: [], money });
    const by = (id: string) => r.findings.find((f) => f.claim.id === id)!;
    expect(by(second.id).indicators.map((i) => i.code)).toEqual(['DUPLICATE_RECEIPT', 'LATE_RECEIPT']);
    expect(by(second.id).indicators[0]).toMatchObject({ lineNos: [1], otherClaim: { id: first.id, claimantName: 'Asha' } });
    expect(by(second.id).indicators[0]!.detail).toBe(`Line 1: INR 845.5 on ${formatDateText(d(22))} at CAFE COFFEE DAY is also line 1 of ${first.number}, claimed by Asha`);
    expect(by(second.id).indicators[1]!.detail).toBe('Line 2 is dated more than 60 days before the claim was submitted (the oldest 76 days)');
    expect(by(first.id).indicators.map((i) => i.code)).toEqual(['DUPLICATE_RECEIPT']);
    // 15 Nov 2026 is a Sunday.
    expect(by(big.id).indicators.map((i) => i.code)).toEqual(['NO_RECEIPTS', 'SUNDAY', 'ROUND_AMOUNT']);
    expect(by(big.id).indicators[0]!.detail).toBe('INR 5600 of receipts claimed with no file attached');
    expect(by(big.id).indicators[1]!.detail).toBe('Line 2 is dated on a Sunday');
    expect(by(big.id).indicators[2]!.detail).toBe('Lines 1, 2 are a round amount (INR 2500, INR 3100), unusual for a real bill');
    expect(r.findings.some((f) => f.claim.id === draft.id)).toBe(false);
    expect(r.findings.map((f) => f.claim.id)).toEqual([second.id, first.id, big.id]);
    expect(by(second.id).score).toBe(5);
    expect(r.people).toEqual([
      { claimantId: 'ravi', claimantName: 'Ravi', claims: 2, flagged: 2, high: 1, medium: 2, low: 2, score: 9, flaggedTotal: [{ currency: 'INR', amount: '7085.75' }], codes: ['DUPLICATE_RECEIPT', 'LATE_RECEIPT', 'NO_RECEIPTS', 'SUNDAY', 'ROUND_AMOUNT'] },
      { claimantId: 'asha', claimantName: 'Asha', claims: 1, flagged: 1, high: 1, medium: 0, low: 0, score: 3, flaggedTotal: [{ currency: 'INR', amount: '845.50' }], codes: ['DUPLICATE_RECEIPT'] },
    ]);
  });

  it('uses the category when a merchant is missing, and ignores other currencies and rejected claims', () => {
    const a = claim('asha', d(10), [line(1, d(12), '450.00')]);
    const b = claim('ravi', d(9), [line(1, d(12), '450.00', { merchant: 'Somewhere' })]);
    const c = claim('ravi', d(8), [line(1, d(12), '450.00', { accountId: 'travel' })]);
    const e = claim('ravi', d(7), [line(1, d(12), '450.00')], { currency: 'USD' });
    const f = claim('ravi', d(6), [line(1, d(12), '450.00')], { status: 'REJECTED' });
    const r = expenseRisk([a, b, c, e, f], { from: d(30), asOf: T, limits: [], money });
    expect(r.findings.map((x) => x.claim.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('reuses the limit and usual-amount checks, and spots someone often just under a limit', () => {
    const limits = [{ accountId: 'meals', amount: '1000' }];
    const history = Array.from({ length: 8 }, (_, k) => claim('asha', d(100 + k), [line(1, d(101 + k), `${300 + k * 10}.00`)]));
    const u1 = claim('ravi', d(60), [line(1, d(61), '980.00')]);
    const u2 = claim('ravi', d(30), [line(1, d(32), '990.00')]);
    const u3 = claim('ravi', d(9), [line(1, d(11), '975.00'), line(2, d(9), '600.00'), line(3, d(9), '700.00')]);
    const huge = claim('asha', d(8), [line(1, d(8), '4870.00', { accountId: 'meals' })]);
    const r = expenseRisk([...history, u1, u2, u3, huge], { from: d(20), asOf: T, limits, money });
    const by = (id: string) => r.findings.find((f) => f.claim.id === id)!;
    expect(by(u3.id).indicators.map((i) => i.code)).toEqual(['SPLIT_UNDER_LIMIT', 'JUST_UNDER_LIMIT', 'REPEATED_JUST_UNDER']);
    expect(by(u3.id).indicators[2]!.detail).toBe(`3 lines just under a per-receipt limit on Ravi's claims in the 90 days to ${formatDateText(d(9))}`);
    expect(by(u3.id).level).toBe('HIGH');
    expect(by(huge.id).indicators.map((i) => i.code)).toEqual(['UNUSUAL_AMOUNT']);
    expect(r.findings.map((f) => f.claim.id)).toEqual([u3.id, huge.id]);
  });
});
