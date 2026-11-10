import { describe, expect, it } from 'vitest';
import { decisionAllowed, detailChecks, onboardingProgress, submitIssues, termsIssues } from '../src/customer-onboarding';

const blank = { email: null, address: null, pincode: null, gstin: null, pan: null, taxId: null };

describe('customer onboarding', () => {
  it('reads the details from the customer record, with Indian PIN code and GSTIN or PAN', () => {
    const none = detailChecks(blank, { creditLimit: null, paymentTermsDays: null }, 'IN');
    expect(none.map((d) => d.done)).toEqual([false, false, false, false]);
    const half = detailChecks({ ...blank, email: 'a@b.test', address: 'Pune', pincode: '4110' }, { creditLimit: '0', paymentTermsDays: 30 }, 'IN');
    expect(half.map((d) => [d.key, d.done])).toEqual([['EMAIL', true], ['ADDRESS', false], ['TAX_ID', false], ['CREDIT_TERMS', true]]);
    const full = detailChecks({ ...blank, email: 'a@b.test', address: 'Pune', pincode: '411045', pan: 'ABCPE1234F' }, { creditLimit: '50000', paymentTermsDays: 15 }, 'IN');
    expect(full.every((d) => d.done)).toBe(true);
    // Elsewhere no PIN code, and any tax number.
    expect(detailChecks({ ...blank, address: 'London', taxId: 'GB123' }, { creditLimit: null, paymentTermsDays: null }, 'GB').map((d) => d.done)).toEqual([false, true, true, false]);
  });

  it('checks proposed terms', () => {
    expect(termsIssues('100000.50', 30)).toEqual([]);
    expect(termsIssues('-1', 30)).toEqual(['The credit limit cannot be negative']);
    expect(termsIssues('1.234', 400)).toEqual(['The credit limit has at most two decimals', 'Payment terms are 0 to 365 days']);
    expect(termsIssues('abc', null)).toEqual(['The credit limit must be a number']);
  });

  it('lists what stands in the way of submitting, and the progress', () => {
    const details = detailChecks({ ...blank, email: 'a@b.test', address: 'Pune', pincode: '411045', gstin: '27AAPFU0939F1ZV' }, { creditLimit: '0', paymentTermsDays: 0 }, 'IN');
    const items = [
      { label: 'KYC', needsFile: true, done: true, hasFile: false },
      { label: 'Credit check', needsFile: false, done: false, hasFile: false },
    ];
    expect(submitIssues(details, items)).toEqual(['KYC: attach the file', 'Credit check: not done yet']);
    expect(onboardingProgress(details, items)).toBe(67);
    expect(submitIssues(details, [{ ...items[0]!, hasFile: true }, { ...items[1]!, done: true }])).toEqual([]);
  });

  it('needs a second person to approve unless nobody else can', () => {
    expect(decisionAllowed('u1', 'u2', 0)).toEqual({ allowed: true, selfApproved: false });
    expect(decisionAllowed('u1', 'u1', 2).allowed).toBe(false);
    expect(decisionAllowed('u1', 'u1', 0)).toEqual({ allowed: true, selfApproved: true });
  });
});

describe('vendor onboarding', () => {
  it('reads the vendor record, its verified bank details and agreed payment terms', async () => {
    const { vendorDetailChecks } = await import('../src/customer-onboarding');
    const none = vendorDetailChecks(blank, { bankVerified: false, paymentTermsDays: null }, 'IN');
    expect(none.map((d) => [d.key, d.done])).toEqual([['EMAIL', false], ['ADDRESS', false], ['TAX_ID', false], ['BANK', false], ['PAYMENT_TERMS', false]]);
    expect(none[2]!.hint).toBe('Add the GSTIN, or the PAN of an unregistered vendor.');
    const all = vendorDetailChecks({ ...blank, email: 'ap@v.test', address: 'Pune', pincode: '411001', pan: 'ABCPE1234F' }, { bankVerified: true, paymentTermsDays: 30 }, 'IN');
    expect(all.every((d) => d.done)).toBe(true);
  });
});
