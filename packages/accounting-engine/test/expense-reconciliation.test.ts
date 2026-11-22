import { describe, expect, it } from 'vitest';
import { reconcileExpenseClaims, type ExpenseReconClaim, type ExpenseReconLedgerLine, type ExpenseReconReimbursement } from '../src/expense-reconciliation';

const asOf = '2026-11-20';
const claim = (number: string, claimant: string, total: string, approvedOn: string, more: Partial<ExpenseReconClaim> = {}): ExpenseReconClaim => ({
  id: number, number, claimantId: claimant, claimant: `Person ${claimant}`, title: `Trip ${number}`, total, approvedOn, reimbursedOn: null, voidDate: null, entryIds: [`${number}-a`], ...more,
});
const line = (entryId: string, date: string, net: string, more: Partial<ExpenseReconLedgerLine> = {}): ExpenseReconLedgerLine => ({ entryId, entryNumber: 1, date, memo: null, source: 'EXPENSE_CLAIM', net, ...more });
const claims = [
  claim('EXP-1', 'a', '1000.00', '2026-11-10'),
  claim('EXP-2', 'a', '2500.00', '2026-09-01'),
  claim('EXP-3', 'b', '400.00', '2026-10-15', { reimbursedOn: '2026-11-01', entryIds: ['EXP-3-a', 'EXP-3-r'] }),
  claim('EXP-4', 'b', '700.00', '2026-10-01', { voidDate: '2026-10-05', entryIds: ['EXP-4-a', 'EXP-4-v'] }),
  claim('EXP-5', 'c', '300.00', '2026-11-21'),
];
const ledger = [
  line('EXP-1-a', '2026-11-10', '1000.00'),
  line('EXP-2-a', '2026-09-01', '2500.00'),
  line('EXP-3-a', '2026-10-15', '400.00'),
  line('EXP-3-r', '2026-11-01', '-400.00'),
  line('EXP-4-a', '2026-10-01', '700.00'),
  line('EXP-4-v', '2026-10-05', '-700.00'),
  line('EXP-5-a', '2026-11-21', '300.00'),
];

describe('expense reconciliation', () => {
  it('reconciles the account to the claims owed, with ageing by employee', () => {
    const r = reconcileExpenseClaims({ claims, ledger, reimbursements: [], asOf, currency: 'INR', scale: 2 });
    expect(r).toMatchObject({ ledger: '3500.00', claims: '3500.00', difference: '0.00', reconciled: true, items: [] });
    expect(r.owed.map((o) => [o.number, o.days, o.overdue])).toEqual([['EXP-2', 80, true], ['EXP-1', 10, false]]);
    expect(r.ages.map((a) => [a.key, a.claims, a.amount])).toEqual([['D0_15', 1, '1000.00'], ['D16_30', 0, '0.00'], ['D31_60', 0, '0.00'], ['OVER_60', 1, '2500.00']]);
    expect(r.employees).toEqual([{ claimantId: 'a', claimant: 'Person a', claims: 2, amount: '3500.00', oldestDays: 80, overdue: '2500.00' }]);
    expect(r.overdue).toEqual({ claims: 1, amount: '2500.00' });
  });

  it('lists entries no claim made and claims whose entries differ', () => {
    const odd = [...ledger.filter((l) => l.entryId !== 'EXP-3-r'), line('je-9', '2026-04-01', '150.00', { entryNumber: 9, memo: 'Opening balances', source: 'OPENING_BALANCE' })];
    const r = reconcileExpenseClaims({ claims, ledger: odd, reimbursements: [], asOf, currency: 'INR', scale: 2 });
    expect(r).toMatchObject({ ledger: '4050.00', claims: '3500.00', difference: '550.00', reconciled: false });
    expect(r.items).toEqual([
      { kind: 'NOT_FROM_A_CLAIM', date: '2026-04-01', reference: 'JE-9', description: 'Opening balances: an entry on the account that no expense claim made (opening balance)', amount: '150.00', entryId: 'je-9', claimId: null },
      { kind: 'CLAIM_DIFFERS', date: '2026-10-15', reference: 'EXP-3', description: 'Its entries show ₹400.00 owed on 20 Nov 2026; the claim says ₹0.00', amount: '400.00', entryId: null, claimId: 'EXP-3' },
    ]);
    expect(r.items.reduce((s, i) => s + Number(i.amount), 0)).toBe(550); // not money: test arithmetic
  });

  it('checks reimbursements against the bank statement', () => {
    const r0 = (number: string, date: string, matched: boolean, statementThrough: string | null): ExpenseReconReimbursement => ({ claimId: number, number, claimant: 'Person b', amount: '400', date, bankAccount: 'HDFC Current', matched, statementThrough });
    const r = reconcileExpenseClaims({
      claims, ledger, asOf, currency: 'INR', scale: 2,
      reimbursements: [r0('EXP-3', '2026-11-01', true, '2026-11-15'), r0('EXP-6', '2026-11-05', false, '2026-11-15'), r0('EXP-7', '2026-11-14', false, '2026-11-15'), r0('EXP-8', '2026-08-01', false, null)],
    });
    expect(r.reimbursements.map((x) => [x.number, x.status, x.days])).toEqual([['EXP-6', 'NOT_ON_STATEMENT', 15], ['EXP-7', 'AWAITING_STATEMENT', 6], ['EXP-3', 'CLEARED', 19]]);
    expect(r.bank).toEqual({ cleared: 1, notOnStatement: 1, notOnStatementAmount: '400.00', awaiting: 1 });
  });
});
