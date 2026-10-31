import { describe, expect, it } from 'vitest';
import {
  D,
  StatementImportError,
  StatementMapping,
  parseCsv,
  parseStatement,
  parseStatementAmount,
  parseStatementDate,
  reconciliationDifference,
  reconciliationIssues,
  statementLineKeys,
  suggestMatches,
} from '../src';

const base: StatementMapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };

describe('CSV parsing', () => {
  it('handles quotes, doubled quotes, CRLF, a BOM and blank lines', () => {
    const rows = parseCsv('﻿a,"b, with comma","say ""hi"""\r\n\r\n1,2,3\n');
    expect(rows).toEqual([
      ['a', 'b, with comma', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('refuses an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(StatementImportError);
  });

  it('parses dates in each supported format and rejects impossible ones', () => {
    expect(parseStatementDate('05/04/2026', 'DD/MM/YYYY')).toBe('2026-04-05');
    expect(parseStatementDate('04/05/2026', 'MM/DD/YYYY')).toBe('2026-04-05');
    expect(parseStatementDate('5.4.2026', 'DD.MM.YYYY')).toBe('2026-04-05');
    expect(parseStatementDate('2026-4-5', 'YYYY-MM-DD')).toBe('2026-04-05');
    expect(() => parseStatementDate('31/02/2026', 'DD/MM/YYYY')).toThrow();
    expect(() => parseStatementDate('2026-04-05', 'DD/MM/YYYY')).toThrow();
  });

  it('parses amounts exactly, with separators, brackets and DR/CR, never via floats', () => {
    expect(parseStatementAmount('1,23,456.78')!.toFixed()).toBe('123456.78');
    expect(parseStatementAmount('(12.50)')!.toFixed()).toBe('-12.5');
    expect(parseStatementAmount('12.50 DR')!.toFixed()).toBe('-12.5');
    expect(parseStatementAmount('12.50CR')!.toFixed()).toBe('12.5');
    expect(parseStatementAmount('₹ 0.10')!.plus(parseStatementAmount('0.20')!).toFixed()).toBe('0.3');
    expect(parseStatementAmount('')).toBeNull();
    expect(() => parseStatementAmount('12a')).toThrow();
  });
});

describe('statement import', () => {
  it('reads a single signed amount column', () => {
    const lines = parseStatement('Date,Narration,Ref,Amount\n01/10/2026,NEFT HARBOUR CAFE,UTR1,"11,800.00"\n02/10/2026,Rent,,-25000\n', base, 'INR');
    expect(lines.map((l) => [l.row, l.date, l.description, l.reference, l.amount.toFixed(2)])).toEqual([
      [2, '2026-10-01', 'NEFT HARBOUR CAFE', 'UTR1', '11800.00'],
      [3, '2026-10-02', 'Rent', null, '-25000.00'],
    ]);
  });

  it('reads separate money-in and money-out columns', () => {
    const m: StatementMapping = { date: 0, description: 1, moneyOut: 2, moneyIn: 3, dateFormat: 'YYYY-MM-DD', hasHeader: false };
    const lines = parseStatement('2026-10-01,Deposit,,500\n2026-10-02,Card,120.40,\n', m, 'INR');
    expect(lines.map((l) => l.amount.toFixed(2))).toEqual(['500.00', '-120.40']);
  });

  it('reports every bad row at once', () => {
    try {
      parseStatement('h\n99/99/2026,x,,1\n01/10/2026,,,1\n01/10/2026,y,,0\n01/10/2026,z,,1.001\n', base, 'INR');
      expect.unreachable();
    } catch (e) {
      expect((e as StatementImportError).issues).toEqual([
        expect.stringMatching(/^Row 2:/),
        'Row 3: description is empty',
        'Row 4: amount is missing or zero',
        expect.stringMatching(/^Row 5:/),
      ]);
    }
  });

  it('gives identical lines different keys, and the same keys on re-import', () => {
    const a = parseStatement('h\n01/10/2026,Fee,,-10\n01/10/2026,Fee,,-10\n', base, 'INR');
    const k1 = statementLineKeys('acct', a);
    expect(new Set(k1).size).toBe(2);
    const b = parseStatement('h\n01/10/2026,FEE,,-10.00\n01/10/2026,Fee,,-10\n02/10/2026,Fee,,-10\n', base, 'INR');
    const k2 = statementLineKeys('acct', b);
    expect(k2.slice(0, 2)).toEqual(k1);
    expect(statementLineKeys('other', a)).not.toEqual(k1);
  });
});

describe('matching', () => {
  const s = (id: string, date: string, amount: string, text: string) => ({ id, date, amount: new D(amount), text });

  it('suggests same-amount lines within the window, preferring shared text and closer dates', () => {
    const out = suggestMatches(
      [s('s1', '2026-10-05', '11800', 'NEFT HARBOUR CAFE INV-000001'), s('s2', '2026-10-06', '-500', 'Card')],
      [s('j1', '2026-10-01', '11800', 'RCPT-000003 · Someone else'), s('j2', '2026-10-03', '11800', 'RCPT-000004 · Harbour Cafe'), s('j3', '2026-11-30', '-500', 'Far away')],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ statementLineId: 's1', journalLineId: 'j2', unique: false });
    expect(out[0].reasons).toContain('Shared text: harbour, cafe');
  });

  it('marks a pair unique only when neither side has another candidate', () => {
    const out = suggestMatches([s('s1', '2026-10-05', '-250', 'x')], [s('j1', '2026-10-05', '-250', 'y')]);
    expect(out[0]).toMatchObject({ journalLineId: 'j1', unique: true });
  });
});

describe('reconciliation', () => {
  it('reconciles when the ledger less uncleared items equals the statement', () => {
    const f = { computedStatementBalance: new D('900'), statementBalance: new D('900'), ledgerBalance: new D('1000'), uncleared: new D('100') };
    expect(reconciliationDifference(f).isZero()).toBe(true);
    expect(reconciliationIssues(f, 0)).toEqual([]);
  });

  it('explains each reason it does not', () => {
    const f = { computedStatementBalance: new D('890'), statementBalance: new D('900'), ledgerBalance: new D('1000'), uncleared: new D('50') };
    const issues = reconciliationIssues(f, 2);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toContain('difference 10.00');
    expect(issues[1]).toBe('2 statement lines are not matched or excluded yet');
    expect(issues[2]).toContain('50.00');
  });
});
