import { describe, expect, it } from 'vitest';
import { describeSharedReceiptFile, expenseRisk, sharedReceiptFiles } from '../src';

describe('the same receipt file claimed twice', () => {
  const holders = [
    { sha256: 'a', kind: 'EXPENSE_CLAIM' as const, id: 'c1', label: 'CLM-0001, Asha' },
    { sha256: 'a', kind: 'EXPENSE_CLAIM' as const, id: 'c2', label: 'CLM-0002, Ravi' },
    { sha256: 'a', kind: 'BILL' as const, id: 'b1', label: 'Bill BILL-0007' },
    { sha256: 'a', kind: 'BILL' as const, id: 'b1', label: 'Bill BILL-0007' },
    { sha256: 'z', kind: 'EXPENSE_CLAIM' as const, id: 'c1', label: 'CLM-0001, Asha' },
  ];

  it('finds each claim file on other claims and bills, never on itself', () => {
    const r = sharedReceiptFiles(
      [
        { claimId: 'c1', sha256: 'a', fileName: 'taxi.jpg' },
        { claimId: 'c1', sha256: 'a', fileName: 'taxi-again.jpg' },
        { claimId: 'c1', sha256: 'z', fileName: 'lunch.pdf' },
        { claimId: 'c3', sha256: 'q', fileName: 'other.pdf' },
      ],
      holders,
    );
    expect([...r.keys()]).toEqual(['c1']);
    expect(r.get('c1')!.map((s) => [s.fileName, s.on.map((h) => h.id)])).toEqual([['taxi.jpg', ['c2', 'b1']]]);
    expect(describeSharedReceiptFile(r.get('c1')![0]!)).toBe('taxi.jpg is also on CLM-0002, Ravi and Bill BILL-0007');
    expect(describeSharedReceiptFile({ fileName: 'x.png', on: [holders[2]!] })).toBe('x.png is also on Bill BILL-0007');
  });

  it('raises a high indicator in the expense risk view, naming the other claim', () => {
    const claim = (id: string, number: string, sharedFiles?: { fileName: string; on: typeof holders }[]) => ({
      id,
      number,
      claimantId: id === 'c1' ? 'u1' : 'u2',
      claimantName: id === 'c1' ? 'Asha' : 'Ravi',
      status: 'SUBMITTED',
      submittedOn: '2026-11-20',
      currency: 'INR',
      total: '640.00',
      receiptCount: 1,
      sharedFiles,
      lines: [{ lineNo: 1, date: id === 'c1' ? '2026-11-18' : '2026-11-17', accountId: 'meals', accountLabel: '6600 · Meals', merchant: id === 'c1' ? 'Cafe' : 'Diner', amount: id === 'c1' ? '640.00' : '410.00' }],
    });
    const r = expenseRisk([claim('c1', 'CLM-0001', [{ fileName: 'taxi.jpg', on: [holders[1]!] }]), claim('c2', 'CLM-0002')], { from: '2026-11-01', asOf: '2026-11-23', limits: [], money: (a) => a });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.level).toBe('HIGH');
    expect(r.findings[0]!.indicators[0]).toMatchObject({ code: 'SAME_RECEIPT_FILE', label: 'Same receipt file elsewhere', detail: 'taxi.jpg is also on CLM-0002, Ravi', otherClaim: { id: 'c2', number: 'CLM-0002', claimantName: 'Ravi' } });
    expect('sharedFiles' in r.findings[0]!.claim).toBe(false);
  });
});
