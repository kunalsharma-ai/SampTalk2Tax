import { describe, expect, it } from 'vitest';
import { cashPaymentDisallowances, cashReceiptBreaches, gstExpenditureBreakup, inr, monthsOrPart, taxAuditApplicability, tdsLateDeposits } from '../src/india/tax-audit';

describe('tax audit support', () => {
  it('decides whether a tax audit is needed under section 44AB(a)', () => {
    expect(inr('12345678.5')).toBe('1,23,45,678.50');
    expect(inr('999')).toBe('999.00');
    const low = taxAuditApplicability({ turnover: '60000000', totalReceipts: '1000000', cashReceipts: '50000', totalPayments: '800000', cashPayments: '10000' });
    expect(low).toMatchObject({ required: false, limit: '100000000', cashReceiptsShare: '5.00', cashPaymentsShare: '1.25' });
    const high = taxAuditApplicability({ turnover: '60000000', totalReceipts: '1000000', cashReceipts: '50001', totalPayments: '800000', cashPayments: '0' });
    expect(high).toMatchObject({ required: true, limit: '10000000' });
    expect(high.reasons[0]).toBe('Turnover 6,00,00,000.00 against a limit of 1 crore');
    expect(high.reasons[1]).toBe('Cash is more than 5% of receipts (5.00%), so the 1 crore limit applies');
  });

  it('groups cash by person and day', () => {
    const f = (id: string, date: string, contactId: string, amount: string) => ({ id, date, contactId, contactName: contactId.toUpperCase(), amount, number: id });
    expect(cashPaymentDisallowances([f('P1', '2026-05-02', 'a', '6000'), f('P2', '2026-05-02', 'a', '5000'), f('P3', '2026-05-03', 'a', '10000'), f('P4', '2026-05-02', 'b', '9000')])).toEqual([
      { date: '2026-05-02', contactId: 'a', contactName: 'A', amount: '11000.00', count: 2, numbers: ['P1', 'P2'] },
    ]);
    expect(cashReceiptBreaches([f('R1', '2026-06-01', 'c', '200000'), f('R2', '2026-06-02', 'c', '199999.99')]).map((r) => r.numbers)).toEqual([['R1']]);
  });

  it('works out TDS interest for every month or part from deduction to deposit', () => {
    expect(monthsOrPart('2026-04-10', '2026-05-07')).toBe(1);
    expect(monthsOrPart('2026-04-10', '2026-05-10')).toBe(1);
    expect(monthsOrPart('2026-04-10', '2026-05-11')).toBe(2);
    const t = tdsLateDeposits(
      [
        { number: 'B1', section: '194C', contactName: 'X', date: '2026-04-10', dueDate: '2026-05-07', amount: '1000', depositDate: '2026-05-06' },
        { number: 'B2', section: '194J', contactName: 'Y', date: '2026-04-10', dueDate: '2026-05-07', amount: '1000', depositDate: '2026-06-15' },
        { number: 'B3', section: '194J', contactName: 'Y', date: '2026-05-20', dueDate: '2026-06-07', amount: '333', depositDate: null },
      ],
      '2026-08-01',
    );
    expect(t).toMatchObject({ deducted: '2333.00', deposited: '2000.00', notDeposited: '333.00', late: 2, interest: '60.00' });
    expect(t.rows.map((r) => [r.number, r.months, r.interest, r.deposited])).toEqual([
      ['B2', 3, '45.00', true],
      ['B3', 3, '15.00', false],
    ]);
  });

  it('splits expenditure by GST registration', () => {
    expect(gstExpenditureBreakup([{ amount: '1000', registered: true }, { amount: '-100', registered: true }, { amount: '250.50', registered: false }])).toEqual({ total: '1150.50', registered: '900.00', unregistered: '250.50' });
  });
});
