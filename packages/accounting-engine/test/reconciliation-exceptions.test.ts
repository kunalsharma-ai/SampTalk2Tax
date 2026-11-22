import { describe, expect, it } from 'vitest';
import { addDays } from '../src/documents';
import { formatDateText } from '../src/workflows';
import { reconciliationExceptions, type ReconItem } from '../src/reconciliation-exceptions';

const T = '2026-11-21';
const item = (id: string, ago: number, amount: string, text = id): ReconItem => ({ id, date: addDays(T, -ago), amount, text });

describe('reconciliation exceptions (BANK-020)', () => {
  it('sorts every unmatched item into an exception with what to do', () => {
    const statement = [
      item('s-fee', 10, '49800.00', 'NEFT CR LOTUS'),
      item('s-chq1', 12, '12000.00', 'CHQ DEP'),
      item('s-chq2', 12, '8000.00', 'CHQ DEP'),
      item('s-rev1', 20, '-5000.00', 'IMPS DR'),
      item('s-rev2', 18, '5000.00', 'IMPS RETURN'),
      item('s-chg', 5, '-590.00', 'ACCOUNT MAINT CHARGES Q3'),
      item('s-int', 3, '1234.00', 'INT.PD SB'),
      item('s-misc', 40, '-7000.00', 'POS SOMEWHERE'),
    ];
    const book = [
      item('b-inv', 11, '50000.00', 'Receipt Lotus'),
      item('b-two', 13, '20000.00', 'Receipt Banyan'),
      item('b-new', 1, '-3000.00', 'Cheque 101'),
      item('b-old', 75, '-15000.00', 'Cheque 88'),
      item('b-mid', 20, '-2000.00', 'Cheque 95'),
    ];
    const r = reconciliationExceptions(statement, book, addDays(T, -2), T, 2);
    const by = (kind: string) => r.exceptions.filter((e) => e.kind === kind);
    expect(by('AMOUNT_DIFFERS')).toHaveLength(1);
    expect(by('AMOUNT_DIFFERS')[0]).toMatchObject({ statement: [{ id: 's-fee' }], book: [{ id: 'b-inv' }], difference: '-200.00', amount: '49800.00' });
    expect(by('AMOUNT_DIFFERS')[0]!.detail).toBe('The bank shows 49800.00 and the books 50000.00: 200.00 less at the bank');
    expect(by('SPLIT')[0]).toMatchObject({ book: [{ id: 'b-two' }], amount: '20000.00' });
    expect(by('SPLIT')[0]!.statement.map((s) => s.id).sort()).toEqual(['s-chq1', 's-chq2']);
    expect(by('REVERSED')[0]!.statement.map((s) => s.id)).toEqual(['s-rev1', 's-rev2']);
    expect(by('REVERSED')[0]!.amount).not.toMatch(/^-/);
    expect(by('BANK_CHARGES').map((e) => e.statement[0]!.id).sort()).toEqual(['s-chg', 's-int']);
    expect(by('NOT_IN_BOOKS')).toMatchObject([{ statement: [{ id: 's-misc' }], age: 40 }]);
    expect(by('IN_TRANSIT')).toMatchObject([{ book: [{ id: 'b-new' }] }]);
    expect(by('IN_TRANSIT')[0]!.detail).toBe(`Dated after the latest statement line (${formatDateText(addDays(T, -2))})`);
    expect(by('STALE')).toMatchObject([{ book: [{ id: 'b-old' }], age: 75 }]);
    expect(by('OUTSTANDING')).toMatchObject([{ book: [{ id: 'b-mid' }] }]);
    expect(r.exceptions.map((e) => e.kind)).toEqual(['AMOUNT_DIFFERS', 'SPLIT', 'REVERSED', 'BANK_CHARGES', 'BANK_CHARGES', 'NOT_IN_BOOKS', 'STALE', 'IN_TRANSIT', 'OUTSTANDING']);
    expect(r.summary.find((s) => s.kind === 'BANK_CHARGES')).toEqual({ kind: 'BANK_CHARGES', label: 'Bank charges or interest', count: 2, amount: '1824.00' });
    expect(r.unmatched).toEqual({ statement: 8, book: 5 });
    expect(r.ageing.book.map((b) => b.count)).toEqual([1, 3, 1, 0]);
    expect(r.ageing.statement[0]).toEqual({ label: 'Up to 7 days', count: 2, amount: '1824.00' });
  });

  it('does not pair across directions, too far apart or too different', () => {
    const r = reconciliationExceptions([item('s', 2, '-1000.00', 'X')], [item('a', 2, '1000.00'), item('b', 20, '-1000.00'), item('c', 2, '-1100.00')], T, T, 2);
    expect(r.exceptions.some((e) => e.kind === 'AMOUNT_DIFFERS' || e.kind === 'SPLIT')).toBe(false);
    expect(r.exceptions.find((e) => e.statement[0]?.id === 's')!.kind).toBe('NOT_IN_BOOKS');
  });

  it('pairs the closest amounts first', () => {
    const r = reconciliationExceptions([item('s', 1, '9950.00', 'NEFT')], [item('far', 1, '10100.00'), item('close', 1, '10000.00')], T, T, 2);
    expect(r.exceptions[0]).toMatchObject({ kind: 'AMOUNT_DIFFERS', book: [{ id: 'close' }], difference: '-50.00' });
  });

  it('treats entries as outstanding before any statement', () => {
    const r = reconciliationExceptions([], [item('b', 3, '500.00')], null, T, 2);
    expect(r.exceptions).toMatchObject([{ kind: 'OUTSTANDING', detail: 'No statement has been imported for this account yet' }]);
  });
});
