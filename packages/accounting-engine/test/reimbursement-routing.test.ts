import { describe, expect, it } from 'vitest';
import { routeReimbursements, type RoutingAccount, type RoutingClaim, type RoutingPayee } from '../src/reimbursement-routing';

const T = '2026-11-22';
const claim = (id: string, claimantId: string, claimant: string, total: string, approvedOn: string): RoutingClaim => ({ id, number: `EXP-${id}`, claimantId, claimant, total, approvedOn });
const payee = (claimantId: string, hasSalaryAccount: boolean, lastAccountId: string | null = null, employee = true): RoutingPayee => ({ claimantId, employee: employee ? { id: `e-${claimantId}`, name: claimantId.toUpperCase() } : null, hasSalaryAccount, lastAccountId });
const accounts: RoutingAccount[] = [
  { id: 'A', code: '1120', name: 'Main bank', kind: 'BANK', balance: '50000' },
  { id: 'B', code: '1130', name: 'Second bank', kind: 'BANK', balance: '8000' },
  { id: 'C', code: '1110', name: 'Cash', kind: 'CASH', balance: '6000' },
];

describe('reimbursement routing (EXP-026)', () => {
  it('orders overdue claimants first and picks an account with room for each', () => {
    const plan = routeReimbursements({
      claims: [
        claim('1', 'asha', 'Asha', '3000', '2026-11-10'),
        claim('2', 'asha', 'Asha', '2000', '2026-11-18'),
        claim('3', 'ravi', 'Ravi', '40000', '2026-11-20'),
        claim('4', 'meena', 'Meena', '500', '2026-11-21'),
        claim('5', 'dev', 'Dev', '2500', '2026-11-21'),
        claim('6', 'zoya', 'Zoya', '9000', '2026-11-21'),
      ],
      payees: [payee('asha', true, 'B'), payee('ravi', true), payee('meena', false), payee('dev', true, 'B'), payee('zoya', true)],
      accounts,
      buffer: '5000',
      today: T,
      currency: 'INR',
    });
    expect(plan.groups.map((g) => [g.claimant, g.route, g.account?.id ?? null])).toEqual([
      ['Asha', 'BANK_TRANSFER', 'A'],
      ['Ravi', 'BANK_TRANSFER', 'A'],
      ['Meena', 'CASH', 'C'],
      ['Dev', 'BANK_TRANSFER', 'B'],
      ['Zoya', 'WAIT_FOR_CASH', null],
    ]);
    const asha = plan.groups[0]!;
    expect(asha).toMatchObject({ total: '5000.00', approvedOn: '2026-11-10', daysWaiting: 12, overdue: true });
    expect(asha.claims.map((c) => c.number)).toEqual(['EXP-1', 'EXP-2']);
    // Their usual account B has only 3,000 of room, so the one with the most room is used.
    expect(asha.reason).toBe("ASHA's salary account is on the employee record. Pay from Main bank, the account with the most room.");
    expect(plan.groups[3]!.reason).toContain('Pay from Second bank, the account they were last reimbursed from.');
    expect(plan.groups[2]!.reason).toBe('No salary account on file for them, so pay in cash from Cash, the account with the most room.');
    expect(plan.groups[4]!.reason).toBe('No bank account has room for 9000.00 after keeping the buffer and paying the claims above. Pay when money comes in.');
    expect(plan.accounts.map((a) => [a.id, a.planned, a.left])).toEqual([['A', '45000.00', '5000.00'], ['B', '2500.00', '5500.00'], ['C', '500.00', '5500.00']]);
    expect(plan.totals).toEqual({ claims: 6, people: 5, total: '57000.00', ready: '48000.00', waiting: '9000.00', overdue: 1 });
  });

  it('asks for bank details when there is neither a salary account nor a cash account', () => {
    const plan = routeReimbursements({
      claims: [claim('1', 'x', 'Xavier', '100', '2026-11-20'), claim('2', 'y', 'Yash', '100', '2026-11-20')],
      payees: [payee('y', false)],
      accounts: [accounts[0]!],
      buffer: '0',
      today: T,
      currency: 'INR',
    });
    expect(plan.groups.map((g) => [g.claimant, g.route])).toEqual([['Xavier', 'NEEDS_BANK_DETAILS'], ['Yash', 'NEEDS_BANK_DETAILS']]);
    expect(plan.groups[0]!.reason).toBe('They are not matched to an employee record by email, so there are no bank details to pay into. Add them as an employee with a salary account.');
    expect(plan.groups[1]!.reason).toBe('Y has no salary account on the employee record and there is no cash account. Add their bank details to pay them.');
  });

  it('says when there is no bank account at all', () => {
    const plan = routeReimbursements({ claims: [claim('1', 'a', 'Asha', '100', T)], payees: [payee('a', true)], accounts: [], buffer: '0', today: T, currency: 'INR' });
    expect(plan.groups[0]).toMatchObject({ route: 'WAIT_FOR_CASH', daysWaiting: 0, overdue: false, reason: 'There is no active bank account in your currency to pay from.' });
  });
});
