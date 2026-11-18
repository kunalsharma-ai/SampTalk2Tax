import { describe, expect, it } from 'vitest';
import catalog from '../src/db/constraints/catalog.json';
import { parseCheck, passes } from '../src/db/constraints/sql-expr';

/**
 * The CHECK constraints are evaluated by the API (src/db/constraints) so MongoDB records are held
 * to them. Each one must parse; the e2e tests exercise them on real writes.
 */
const checks = catalog.checks as Record<string, { name: string; def: string }[]>;

const check = (table: string, name: string) => parseCheck(checks[table]!.find((c) => c.name === name)!.def);

describe('CHECK constraints', () => {
  it('parse, every one of them', () => {
    const failed: string[] = [];
    for (const [table, list] of Object.entries(checks))
      for (const c of list)
        try {
          parseCheck(c.def);
        } catch (e) {
          failed.push(`${table}.${c.name}: ${(e as Error).message.slice(0, 200)}`);
        }
    expect(failed).toEqual([]);
  });

  // As SQL evaluates them: a NULL result passes.
  it('give the answers SQL gives', () => {
    const limit = check('contacts', 'contacts_credit_limit_chk');
    expect([passes(limit, { credit_limit: null }), passes(limit, { credit_limit: '0' }), passes(limit, { credit_limit: '-1' })]).toEqual([true, true, false]);
    const gstin = check('contacts', 'contacts_gstin_chk');
    expect(passes(gstin, { gstin: '27ABCDE1234F1Z5', state_code: '27' })).toBe(true);
    expect(passes(gstin, { gstin: '27ABCDE1234F1Z5', state_code: '29' })).toBe(false);
    expect(passes(gstin, { gstin: 'not-a-gstin', state_code: '27' })).toBe(false);
    const dates = check('documents', 'documents_dates_chk');
    expect([passes(dates, { issue_date: new Date('2026-01-02'), due_date: new Date('2026-01-01') }), passes(dates, { issue_date: new Date('2026-01-01'), due_date: null })]).toEqual([false, true]);
    const amounts = check('documents', 'documents_amounts_chk');
    const doc = { subtotal: '100', tax_total: '18', withholding_kind: 'TDS', withholding_amount: '10' };
    expect(passes(amounts, { ...doc, total: '108' })).toBe(true);
    expect(passes(amounts, { ...doc, total: '118' })).toBe(false);
    expect(passes(amounts, { ...doc, withholding_kind: null, total: '118' })).toBe(true);
    const lines = check('journal_lines', 'journal_lines_amounts_chk');
    const line = { debit: '10', credit: '0', functional_debit: '10', functional_credit: '0', exchange_rate: '1' };
    expect([passes(lines, line), passes(lines, { ...line, credit: '10' }), passes(lines, { ...line, exchange_rate: '0' })]).toEqual([true, false, false]);
  });
});
