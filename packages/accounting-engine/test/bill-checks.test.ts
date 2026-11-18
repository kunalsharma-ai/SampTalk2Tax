import { describe, expect, it } from 'vitest';
import { billCheckFingerprint, checkBill, type BillCheckBill } from '../src';

const line = (description: string, unitPrice: string, accountId = 'acc-supplies', taxAmount = '0') => ({ description, accountId, accountName: accountId === 'acc-supplies' ? 'Office supplies' : 'Consulting', quantity: '1', unitPrice, taxAmount });
const bill = (id: string, issueDate: string, total: string, extra: Partial<BillCheckBill> = {}): BillCheckBill => ({ id, number: `BILL-${id}`, reference: `INV-${id}`, issueDate, total, currency: 'INR', lines: [line('A4 paper ream', '250.00', 'acc-supplies', '45.00')], ...extra });
const history = [bill('1', '2026-08-10', '1180.00'), bill('2', '2026-09-10', '1200.00'), bill('3', '2026-10-10', '1250.00')];
const codes = (f: { code: string }[]) => f.map((x) => x.code);

describe('unusual bill checks', () => {
  it('finds nothing in an ordinary bill', () => {
    expect(checkBill({ bill: bill('4', '2026-11-10', '1300.00'), history, bank: { changedAt: '2026-01-05', verifiedAt: '2026-01-06' }, today: '2026-11-17' })).toEqual([]);
  });

  it('flags a reused vendor invoice number, a large amount, a price jump and a new account', () => {
    const b = bill('4', '2026-11-10', '9440.00', { reference: 'inv 2', lines: [line('A4 Paper Ream', '400.00', 'acc-supplies', '72.00'), line('Strategy workshop', '7000.00', 'acc-consulting')] });
    const f = checkBill({ bill: b, history, bank: null, today: '2026-11-17' });
    expect(codes(f)).toEqual(['SAME_VENDOR_REFERENCE', 'AMOUNT_ABOVE_USUAL', 'PRICE_JUMP', 'NEW_ACCOUNT']);
    expect(f[0]).toMatchObject({ severity: 'HIGH', relatedIds: ['2'] });
    expect(f[1]!.detail).toBe('INR 9,440.00 is 7.9 times the usual INR 1,200.00 (median of 3 earlier bills).');
    expect(f[2]!.detail).toBe('A4 Paper Ream: 400.00 a unit against 250.00 on BILL-3 (2026-10-10), up 60%.');
    expect(f[3]!.detail).toBe("Consulting was not used on this vendor's 3 earlier bills.");
    expect(billCheckFingerprint(f)).toBe('AMOUNT_ABOVE_USUAL,NEW_ACCOUNT,PRICE_JUMP,SAME_VENDOR_REFERENCE');
  });

  it('flags bank detail changes, dates and round untaxed amounts', () => {
    const b = bill('9', '2026-11-20', '50000.00', { lines: [line('Advance', '50000.00')] });
    const f = checkBill({ bill: b, history: [], bank: { changedAt: '2026-11-12', verifiedAt: null }, today: '2026-11-17' });
    expect(codes(f)).toEqual(['BANK_DETAILS_CHANGED', 'BANK_DETAILS_UNVERIFIED', 'DATED_AHEAD', 'FIRST_BILL', 'ROUND_AMOUNT']);
    expect(f.find((x) => x.code === 'BANK_DETAILS_CHANGED')!.detail).toContain('8 days before the bill date');
    const old = checkBill({ bill: bill('9', '2026-03-01', '1200.00'), history, bank: { changedAt: '2025-01-01', verifiedAt: '2025-01-02' }, today: '2026-11-17' });
    expect(codes(old)).toEqual(['OLD_BILL']);
  });
});
