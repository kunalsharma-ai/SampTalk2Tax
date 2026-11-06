import { describe, expect, it } from 'vitest';
import { bankDetailIssues, batchItemIssues, maskAccountNumber, normaliseAccountNumber, paymentFileCsv, paymentsByVendor } from '../src/payment-batches';

describe('vendor bank details', () => {
  it('accepts an Indian account and IFSC, and says what is wrong otherwise', () => {
    expect(bankDetailIssues({ accountName: 'Cedar Hardware LLP', accountNumber: '5010 0123-4567', ifsc: 'hdfc0001234' })).toEqual([]);
    expect(bankDetailIssues({ accountName: ' ', accountNumber: '12', ifsc: 'HDFC1001234' })).toHaveLength(3);
    expect(normaliseAccountNumber('5010 0123-4567')).toBe('501001234567');
  });

  it('masks all but the last four characters', () => {
    expect(maskAccountNumber('501001234567')).toBe('XXXXXXXX4567');
    expect(maskAccountNumber('123')).toBe('123');
  });
});

describe('payment batches', () => {
  const base = { vendor: 'Cedar', billStatus: 'POSTED', bank: { hasDetails: true, verified: true } };
  it('finds bills paid since, missing or unverified bank details', () => {
    const issues = batchItemIssues(
      [
        { ...base, documentId: 'a', number: 'BILL-1', amount: '100', due: '100' },
        { ...base, documentId: 'b', number: 'BILL-2', amount: '100', due: '40' },
        { ...base, documentId: 'c', number: 'BILL-3', amount: '10', due: '10', bank: { hasDetails: true, verified: false } },
        { ...base, documentId: 'd', number: 'BILL-4', amount: '10', due: '10', bank: null, billStatus: 'VOID' },
      ],
      'INR',
    );
    expect(issues.map((i) => i.issue)).toEqual([
      'BILL-2 now has 40.00 INR left to pay, less than the 100.00 in the batch',
      "Cedar's bank details were changed and are not verified yet",
      'BILL-4 is no longer posted',
      'Cedar has no bank details',
    ]);
  });

  it('makes one payment per vendor', () => {
    const g = paymentsByVendor([{ contactId: 'v1', amount: '100.10' }, { contactId: 'v2', amount: '5' }, { contactId: 'v1', amount: '0.9' }], 'INR');
    expect(g.map((x) => [x.contactId, x.amount, x.items.length])).toEqual([['v1', '101.00', 2], ['v2', '5.00', 1]]);
  });

  it('writes the bank file with formulas neutralised', () => {
    const csv = paymentFileCsv({ reference: 'PB-0001', date: '2026-11-06', debitAccount: '1120 Operating Bank Account', currency: 'INR' }, [
      { vendor: 'Cedar, Hardware', accountName: '=HYPERLINK("x")', accountNumber: '501001234567', ifsc: 'HDFC0001234', amount: '101.00', reference: 'PB-0001 BILL-1 BILL-3', email: null },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Payment date,Debit account,Beneficiary name,Beneficiary account number,IFSC,Amount,Currency,Payment reference,Beneficiary email,Vendor');
    expect(lines[1]).toBe(`2026-11-06,1120 Operating Bank Account,"'=HYPERLINK(""x"")",501001234567,HDFC0001234,101.00,INR,PB-0001 BILL-1 BILL-3,,"Cedar, Hardware"`);
  });
});
