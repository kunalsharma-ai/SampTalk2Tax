import { describe, expect, it } from 'vitest';
import { vendorReviewNeed, vendorRiskLevel, vendorSpendShare, validateVendorRiskReview, vendorRiskFactors, type VendorRiskFacts } from '../src/vendor-risk';

const T = '2026-11-10';
const money = (a: string) => `₹${a}`;
const base: VendorRiskFacts = {
  createdOn: '2025-01-01',
  spend: '10000.00',
  totalSpend: '100000.00',
  openPayable: '0',
  overdue: '0',
  bank: { changedOn: '2025-02-01', verified: true, sameAccountAs: [] },
  tax: { high: 0, medium: 0 },
  grade: 'A',
  onboarding: { required: false, status: null },
};
const run = (f: Partial<VendorRiskFacts>) => vendorRiskFactors({ ...base, ...f }, T, money);
const codes = (f: Partial<VendorRiskFacts>) => run(f).map((x) => `${x.code}:${x.level}`);

describe('vendor risk factors', () => {
  it('finds nothing for a settled, verified, well-graded vendor', () => {
    expect(run({})).toEqual([]);
    expect(vendorRiskLevel(run({}))).toBe('NONE');
  });

  it('weighs bank detail changes by verification and money owed', () => {
    expect(codes({ bank: { changedOn: '2026-11-01', verified: false, sameAccountAs: [] }, openPayable: '5000.00' })).toEqual(['BANK_CHANGED_UNVERIFIED:HIGH']);
    expect(codes({ bank: { changedOn: '2026-11-01', verified: false, sameAccountAs: [] } })).toEqual(['BANK_CHANGED_UNVERIFIED:MEDIUM']);
    expect(codes({ bank: { changedOn: '2026-01-01', verified: false, sameAccountAs: [] }, openPayable: '5000.00' })).toEqual(['BANK_UNVERIFIED:MEDIUM']);
    expect(codes({ bank: { changedOn: '2026-01-01', verified: false, sameAccountAs: [] } })).toEqual([]);
    expect(codes({ bank: { changedOn: '2026-11-01', verified: true, sameAccountAs: [] } })).toEqual(['BANK_CHANGED_RECENTLY:LOW']);
    const shared = run({ bank: { changedOn: '2025-02-01', verified: true, sameAccountAs: ['Acme Traders'] } });
    expect(shared[0]).toMatchObject({ code: 'BANK_SHARED', level: 'HIGH' });
    expect(shared[0]!.detail).toContain('Acme Traders');
    const changed = run({ bank: { changedOn: '2026-11-01', verified: false, sameAccountAs: [] }, openPayable: '5000.00' });
    expect(changed[0]!.detail).toBe('The bank details were changed on 1 Nov 2026 and nobody has verified them yet, with ₹5000.00 owed to the vendor. Confirm the change with the vendor on a number you already have before paying.');
  });

  it('carries over tax problems and poor performance', () => {
    expect(codes({ tax: { high: 1, medium: 2 } })).toEqual(['TAX_PROBLEMS:HIGH']);
    expect(run({ tax: { high: 1, medium: 2 } })[0]!.detail).toMatch(/^3 problems .*, one serious\./);
    expect(codes({ tax: { high: 0, medium: 1 } })).toEqual(['TAX_PROBLEMS:MEDIUM']);
    expect(codes({ grade: 'D' })).toEqual(['POOR_PERFORMANCE:MEDIUM']);
    expect(codes({ grade: 'C' })).toEqual(['POOR_PERFORMANCE:LOW']);
    expect(codes({ grade: null })).toEqual([]);
  });

  it('flags concentration, a new vendor growing fast, onboarding and late payment', () => {
    expect(vendorSpendShare('25000', '100000')).toBe('25.0');
    expect(vendorSpendShare('0', '100000')).toBeNull();
    expect(codes({ spend: '25000.00' })).toEqual(['CONCENTRATION:MEDIUM']);
    expect(codes({ spend: '24999.00' })).toEqual([]);
    expect(codes({ createdOn: '2026-09-01', spend: '12000.00' })).toEqual(['NEW_VENDOR:MEDIUM']);
    expect(codes({ createdOn: '2026-09-01', spend: '9000.00' })).toEqual([]);
    expect(codes({ onboarding: { required: true, status: 'SUBMITTED' } })).toEqual(['ONBOARDING_INCOMPLETE:MEDIUM']);
    expect(run({ onboarding: { required: true, status: null } })[0]!.detail).toContain('not started');
    expect(codes({ onboarding: { required: true, status: 'APPROVED' } })).toEqual([]);
    expect(codes({ onboarding: { required: true, status: null }, spend: '0' })).toEqual([]);
    expect(codes({ overdue: '700.00' })).toEqual(['OVERDUE_PAYABLE:LOW']);
  });

  it('sorts worst first and takes the worst as the level', () => {
    const f = run({ overdue: '700.00', grade: 'D', bank: { changedOn: '2025-02-01', verified: true, sameAccountAs: ['X'] } });
    expect(f.map((x) => x.level)).toEqual(['HIGH', 'MEDIUM', 'LOW']);
    expect(vendorRiskLevel(f)).toBe('HIGH');
  });
});

describe('vendor risk reviews', () => {
  const last = { level: 'MEDIUM' as const, factorCodes: ['CONCENTRATION'], reviewedOn: '2026-10-01', nextReviewOn: '2026-12-30' };
  it('asks for a review of a medium or high risk never reviewed', () => {
    expect(vendorReviewNeed('MEDIUM', [{ code: 'CONCENTRATION' }], null, T)).toEqual({ need: 'NEVER_REVIEWED', newFactors: ['CONCENTRATION'] });
    expect(vendorReviewNeed('LOW', [{ code: 'OVERDUE_PAYABLE' }], null, T).need).toBeNull();
  });
  it('asks again when a new factor appears or the level rises, and when the date comes', () => {
    expect(vendorReviewNeed('MEDIUM', [{ code: 'CONCENTRATION' }], last, T).need).toBeNull();
    expect(vendorReviewNeed('MEDIUM', [{ code: 'CONCENTRATION' }, { code: 'POOR_PERFORMANCE' }], last, T)).toEqual({ need: 'NEW_RISK', newFactors: ['POOR_PERFORMANCE'] });
    expect(vendorReviewNeed('HIGH', [{ code: 'CONCENTRATION' }], last, T).need).toBe('NEW_RISK');
    expect(vendorReviewNeed('MEDIUM', [{ code: 'CONCENTRATION' }], last, '2026-12-30').need).toBe('REVIEW_DUE');
    expect(vendorReviewNeed('NONE', [], last, '2026-12-30').need).toBeNull();
    expect(vendorReviewNeed('LOW', [{ code: 'OVERDUE_PAYABLE' }], last, T).need).toBeNull();
  });
  it('checks a review before it is recorded', () => {
    const ok = { decision: 'MONITOR', note: 'Spoke to their accounts head', reviewedOn: T, nextReviewOn: '2027-02-08' };
    expect(() => validateVendorRiskReview(ok, T)).not.toThrow();
    expect(() => validateVendorRiskReview({ ...ok, decision: 'MAYBE' }, T)).toThrow('Choose a decision');
    expect(() => validateVendorRiskReview({ ...ok, note: ' ok ' }, T)).toThrow(/Say what was looked at/);
    expect(() => validateVendorRiskReview({ ...ok, reviewedOn: '2026-11-11' }, T)).toThrow(/future/);
    expect(() => validateVendorRiskReview({ ...ok, nextReviewOn: T }, T)).toThrow(/after this one/);
    expect(() => validateVendorRiskReview({ ...ok, nextReviewOn: '2027-11-11' }, T)).toThrow(/within 365 days/);
  });
});
