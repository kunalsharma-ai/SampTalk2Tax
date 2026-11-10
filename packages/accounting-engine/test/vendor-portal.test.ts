import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { invoiceNumberKey, makeVendorPortalToken, submissionFileOpen, validateVendorSubmission, vendorBillState, VENDOR_PORTAL_TOKEN_PATTERN, vendorPortalTokenPrefix } from '../src/vendor-portal';
import { PORTAL_TOKEN_PATTERN } from '../src/customer-portal';

describe('vendor portal', () => {
  it('makes vendor tokens that never pass as customer tokens', () => {
    const t = makeVendorPortalToken((n) => randomBytes(n));
    expect(t).toMatch(VENDOR_PORTAL_TOKEN_PATTERN);
    expect(t).not.toMatch(PORTAL_TOKEN_PATTERN);
    expect(makeVendorPortalToken(() => new Uint8Array(64).fill(1))).toBe(`t2tv_${'B'.repeat(40)}`);
    expect(vendorPortalTokenPrefix(`t2tv_${'B'.repeat(40)}`)).toBe('BBBBBBBB');
  });

  it('works out how a bill stands for the vendor', () => {
    const today = '2026-11-10';
    expect(vendorBillState({ status: 'POSTED', total: '100.00', open: '100.00', dueDate: '2026-11-30' }, today)).toBe('TO_BE_PAID');
    expect(vendorBillState({ status: 'POSTED', total: '100.00', open: '100.00', dueDate: '2026-11-10' }, today)).toBe('DUE');
    expect(vendorBillState({ status: 'POSTED', total: '100.00', open: '30.00', dueDate: '2026-11-01' }, today)).toBe('PART_PAID');
    expect(vendorBillState({ status: 'POSTED', total: '100.00', open: '0.00', dueDate: '2026-11-01' }, today)).toBe('PAID');
    expect(vendorBillState({ status: 'VOID', total: '100.00', open: '0.00', dueDate: null }, today)).toBe('VOID');
  });

  it('checks an invoice a vendor sends', () => {
    const ok = { invoiceNumber: 'INV/26-27/0042', invoiceDate: '2026-11-05', amount: '11800.00', currency: 'INR' };
    expect(validateVendorSubmission(ok, '2026-11-10')).toEqual([]);
    expect(validateVendorSubmission({ ...ok, invoiceNumber: '  ' }, '2026-11-10')).toEqual(['Enter your invoice number']);
    expect(validateVendorSubmission({ ...ok, invoiceNumber: 'INV<42>' }, '2026-11-10')).toEqual(['The invoice number can have letters, digits, spaces and - / _ . only']);
    expect(validateVendorSubmission({ ...ok, invoiceDate: '2026-11-11' }, '2026-11-10')).toEqual(['The invoice date cannot be in the future']);
    expect(validateVendorSubmission({ ...ok, invoiceDate: '2025-04-01' }, '2026-11-10')).toEqual(['The invoice is dated more than 18 months ago; contact the business instead']);
    expect(validateVendorSubmission({ ...ok, amount: '0' }, '2026-11-10')).toEqual(['The invoice total must be more than zero']);
    expect(validateVendorSubmission({ ...ok, amount: '10.005' }, '2026-11-10')).toEqual(['Enter the invoice total, with at most 2 decimal places']);
    expect(validateVendorSubmission({ ...ok, currency: 'inr' }, '2026-11-10')).toEqual(['Choose the currency']);
  });

  it('compares invoice numbers without case or separators, and closes the file window', () => {
    expect(invoiceNumberKey('inv/26-27/0042')).toBe(invoiceNumberKey('INV 2627 0042'));
    const at = new Date('2026-11-10T10:00:00Z');
    expect(submissionFileOpen(at, new Date('2026-11-10T10:59:59Z'))).toBe(true);
    expect(submissionFileOpen(at, new Date('2026-11-10T11:00:00Z'))).toBe(false);
  });
});
