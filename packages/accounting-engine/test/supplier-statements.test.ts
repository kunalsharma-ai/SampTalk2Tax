import { describe, expect, it } from 'vitest';
import { type BookItem, dec, normaliseReference, parseStatementCsv, reconcileSupplierStatement, type SupplierStatementLine } from '../src';

const items: BookItem[] = [
  { id: 'b1', kind: 'BILL', number: 'BILL-000001', date: '2026-10-03', reference: 'PM/26-27/101', amount: '11800.00' },
  { id: 'b2', kind: 'BILL', number: 'BILL-000002', date: '2026-10-10', reference: null, amount: '5900.00' },
  { id: 'b3', kind: 'BILL', number: 'BILL-000003', date: '2026-10-20', reference: 'PM/26-27/115', amount: '2360.00' },
  { id: 'p1', kind: 'PAYMENT', number: 'PAY-000001', date: '2026-10-15', reference: 'UTR1111', amount: '-11800.00' },
  { id: 'p2', kind: 'PAYMENT', number: 'PAY-000002', date: '2026-10-30', reference: null, amount: '-3000.00' },
  { id: 'b4', kind: 'BILL', number: 'BILL-000004', date: '2026-10-05', reference: 'X-1', amount: '100.00' },
  { id: 'b4', kind: 'BILL_VOID', number: 'BILL-000004', date: '2026-10-06', reference: 'X-1', amount: '-100.00' },
];
const lines: SupplierStatementLine[] = [
  { date: '2026-10-03', reference: 'PM-26-27-0101', kind: 'INVOICE', amount: '11800.00' },
  { date: '2026-10-11', reference: 'PM/26-27/108', kind: 'INVOICE', amount: '5900.00' },
  { date: '2026-10-20', reference: 'PM/26-27/115', kind: 'INVOICE', amount: '2400.00' },
  { date: '2026-10-18', reference: 'NEFT 1111', kind: 'PAYMENT', amount: '11800.00' },
  { date: '2026-10-28', reference: 'PM/26-27/121', kind: 'INVOICE', amount: '1180.00' },
];

describe('supplier statement reconciliation', () => {
  it('matches by reference, then amount and date, and explains every rupee of the difference', () => {
    // Ours: 1,000 opening + 11,800 + 5,900 + 2,360 - 11,800 - 3,000 = 6,260. Theirs: 1,000 + 9,480 of lines = 10,480.
    const r = reconcileSupplierStatement({ theirOpening: '1000.00', theirClosing: '10480.00', ourOpening: '1000.00', ourClosing: '6260.00', lines, items });
    expect(r.matches.map((m) => [m.line, m.itemId, m.by, m.difference])).toEqual([
      [0, 'b1', 'REFERENCE', '0.00'],
      [2, 'b3', 'REFERENCE', '40.00'],
      [1, 'b2', 'AMOUNT_AND_DATE', '0.00'],
      [3, 'p1', 'AMOUNT_AND_DATE', '0.00'],
    ]);
    expect(r.onlyOnStatement).toMatchObject([{ line: 4, reference: 'PM/26-27/121', effect: '1180.00' }]);
    expect(r.onlyInBooks).toMatchObject([{ id: 'p2', kind: 'PAYMENT', effect: '-3000.00' }]);
    expect(r.balances.difference).toBe('4220.00');
    expect(r.explained).toEqual({ opening: '0.00', onlyOnStatement: '1180.00', onlyInBooks: '3000.00', amountDifferences: '40.00', statementArithmetic: '0.00' });
    expect(r).toMatchObject({ statementAddsUp: true, agrees: false });
    const e = r.explained;
    // The parts add up to the whole difference.
    expect([e.opening, e.onlyOnStatement, e.onlyInBooks, e.amountDifferences, e.statementArithmetic].reduce((a, x) => a.plus(dec(x)), dec('0')).toFixed(2)).toBe(r.balances.difference);
  });

  it('agrees when everything matches, and reports a statement that does not add up', () => {
    const ok = reconcileSupplierStatement({ theirOpening: '0', theirClosing: '0', ourOpening: '0', ourClosing: '0', lines: [{ date: '2026-10-03', reference: 'A1', kind: 'INVOICE', amount: '100' }, { date: '2026-10-09', reference: 'chq 5', kind: 'PAYMENT', amount: '100' }], items: [{ id: 'b', kind: 'BILL', number: 'BILL-9', date: '2026-10-03', reference: 'a-1', amount: '100' }, { id: 'p', kind: 'PAYMENT', number: 'PAY-9', date: '2026-10-01', reference: null, amount: '-100' }] });
    expect(ok).toMatchObject({ agrees: true, statementAddsUp: true });
    const bad = reconcileSupplierStatement({ theirOpening: '0', theirClosing: '150', ourOpening: '0', ourClosing: '100', lines: [{ date: '2026-10-03', reference: 'A1', kind: 'INVOICE', amount: '100' }], items: [{ id: 'b', kind: 'BILL', number: 'BILL-9', date: '2026-10-03', reference: 'A1', amount: '100' }] });
    expect(bad).toMatchObject({ statementAddsUp: false, explained: { statementArithmetic: '50.00' }, agrees: false });
  });

  it('normalises references and reads pasted CSV', () => {
    expect(normaliseReference(' pm/26-27/0101 ')).toBe('PM2627101');
    expect(normaliseReference('00042')).toBe('42');
    const p = parseStatementCsv('Date,Reference,Type,Amount\n03/10/2026,PM/101,Invoice,"11,800.00"\n2026-10-18,NEFT 1111,receipt,11800\n2026-13-01,,refund,abc');
    expect(p.lines).toEqual([{ date: '2026-10-03', reference: 'PM/101', kind: 'INVOICE', amount: '11800.00' }, { date: '2026-10-18', reference: 'NEFT 1111', kind: 'PAYMENT', amount: '11800.00' }]);
    expect(p.errors).toEqual(['Row 4: date "2026-13-01", no reference, type "refund" (use invoice, debit note, credit note or payment), amount "abc"']);
  });
});
