import { describe, expect, it } from 'vitest';
import { documentGstSides, gstinCheckCharacter, gstDiscrepancies, gstReconciliation, type GstReconDocument, type GstReconEntry } from '../src';

const line = (o: Partial<GstReconDocument['lines'][number]> = {}) => ({ hsnCode: '8471', quantity: '1', category: 'TAXABLE' as const, rate: '18', taxable: '1000.00', cgst: '90.00', sgst: '90.00', igst: '0.00', ...o });
const doc = (o: Partial<GstReconDocument>): GstReconDocument => ({
  id: o.number ?? 'x',
  kind: 'INVOICE',
  status: 'POSTED',
  number: 'INV-1',
  issueDate: '2026-10-05',
  contactName: 'Synthetic Buyer',
  gstin: null,
  placeOfSupply: '27',
  nature: 'INTRA',
  total: '1180.00',
  lines: [line()],
  journalEntryId: `je-${o.number ?? 'x'}`,
  voidJournalEntryId: null,
  ...o,
});
const sides = (out: [string, string, string], inp: [string, string, string] = ['0', '0', '0']) => ({ output: { igst: out[0], cgst: out[1], sgst: out[2] }, input: { igst: inp[0], cgst: inp[1], sgst: inp[2] } });
const entry = (id: string, date: string, gst: ReturnType<typeof sides>, source = 'DOCUMENT', number = 1): GstReconEntry => ({ id, number, date, source, memo: null, gst });
const gstin = (first14: string) => first14 + gstinCheckCharacter(first14);
const P = { from: '2026-10-01', to: '2026-10-31' };

describe('documentGstSides', () => {
  it('puts sales on output, purchases on input, reverse charge on both, credit notes negative', () => {
    expect(documentGstSides(doc({}))).toEqual(sides(['0.00', '90.00', '90.00'], ['0.00', '0.00', '0.00']));
    expect(documentGstSides(doc({ kind: 'CREDIT_NOTE' })).output.cgst).toBe('-90.00');
    expect(documentGstSides(doc({ kind: 'BILL', reverseCharge: true }))).toEqual(sides(['0.00', '90.00', '90.00'], ['0.00', '90.00', '90.00']));
    expect(documentGstSides(doc({ kind: 'VENDOR_CREDIT' })).input.sgst).toBe('-90.00');
  });
});

describe('gstReconciliation', () => {
  it('agrees when every entry is the posting of a document of the period, with payments apart', () => {
    const r = gstReconciliation({ ...P, documents: [doc({ number: 'INV-1' })], entries: [entry('je-INV-1', '2026-10-05', sides(['0', '90', '90'])), entry('pay', '2026-10-20', sides(['0', '-90', '-90']), 'TAX')], settlementEntryIds: new Set(['pay']) });
    expect(r.agrees).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.settled.output.cgst).toBe('-90.00');
  });

  it('explains every difference, entry by entry', () => {
    const documents = [
      doc({ number: 'INV-1' }),
      // Posted with different tax than its lines (say the accounts changed).
      doc({ number: 'INV-2', lines: [line({ cgst: '45.00', sgst: '45.00', rate: '9' })] }),
      // Issued in September, posted in October.
      doc({ number: 'INV-0', issueDate: '2026-09-28' }),
      // Issued in October, posted in November.
      doc({ number: 'INV-3' }),
      // Issued in October and voided in November.
      doc({ number: 'INV-4', status: 'VOID', voidJournalEntryId: 'void-INV-4' }),
      // Issued in August, voided in October.
      doc({ number: 'INV-5', status: 'VOID', issueDate: '2026-08-10', voidJournalEntryId: 'void-INV-5' }),
    ];
    const entries = [
      entry('je-INV-1', '2026-10-05', sides(['0', '90', '90'])),
      entry('je-INV-2', '2026-10-06', sides(['0', '50', '50'])),
      entry('je-INV-0', '2026-10-01', sides(['0', '90', '90'])),
      entry('je-INV-4', '2026-10-07', sides(['0', '90', '90'])),
      entry('void-INV-5', '2026-10-09', sides(['0', '-90', '-90'])),
      entry('man', '2026-10-15', sides(['300', '0', '0']), 'MANUAL', 42),
    ];
    const r = gstReconciliation({ ...P, documents, entries, settlementEntryIds: new Set() });
    // Returns: INV-1, INV-2, INV-3 posted in the period: CGST 90 + 45 + 90.
    expect(r.returns.output.cgst).toBe('225.00');
    // Ledger: 90 + 50 + 90 + 90 − 90 (CGST), plus IGST 300.
    expect(r.ledger.output).toEqual({ igst: '300.00', cgst: '230.00', sgst: '230.00' });
    expect(r.difference.output).toEqual({ igst: '300.00', cgst: '5.00', sgst: '5.00' });
    expect(r.unexplained).toEqual(sides(['0.00', '0.00', '0.00'], ['0.00', '0.00', '0.00']));
    expect(r.agrees).toBe(false);
    const kinds = Object.fromEntries(r.items.map((i) => [i.documentNumber ?? i.entryId, i.kind]));
    expect(kinds).toEqual({ man: 'OTHER_ENTRY', 'INV-2': 'POSTING_DIFFERS', 'INV-0': 'ISSUED_OUTSIDE_PERIOD', 'INV-3': 'POSTED_OUTSIDE_PERIOD', 'INV-4': 'VOIDED_DOCUMENT', 'INV-5': 'VOID_OF_EARLIER_DOCUMENT' });
    const manual = r.items.find((i) => i.kind === 'OTHER_ENTRY')!;
    expect(manual.message).toBe('Journal 42 (manual) moved a GST account with no document behind it');
    expect(r.items[0]).toBe(manual); // largest first
    expect(r.items.find((i) => i.kind === 'POSTED_OUTSIDE_PERIOD')!.effect.output.cgst).toBe('-90.00');
    expect(r.items.find((i) => i.kind === 'VOIDED_DOCUMENT')!.message).toMatch(/voided after this period/);
  });

  it('a document posted and voided in the period nets to nothing', () => {
    const r = gstReconciliation({ ...P, documents: [doc({ number: 'INV-9', status: 'VOID', voidJournalEntryId: 'v9' })], entries: [entry('je-INV-9', '2026-10-05', sides(['0', '90', '90'])), entry('v9', '2026-10-06', sides(['0', '-90', '-90']))], settlementEntryIds: new Set() });
    expect(r.agrees).toBe(true);
    expect(r.unexplained.output.cgst).toBe('0.00');
  });
});

describe('gstDiscrepancies', () => {
  it('finds tax problems, worst first', () => {
    const found = gstDiscrepancies([
      doc({ number: 'INV-1', lines: [line({ cgst: '0.00', sgst: '0.00', igst: '180.00' })] }),
      doc({ number: 'INV-2', nature: 'INTER', lines: [line({ hsnCode: null })] }),
      doc({ number: 'INV-3', lines: [line({ cgst: '80.00', sgst: '90.00' }), line({ category: 'EXEMPT', rate: '0', cgst: '5.00', sgst: '5.00' })] }),
      doc({ number: 'INV-4', lines: [line({ rate: '12', cgst: '60.00', sgst: '60.00' })] }),
      doc({ number: 'INV-5', gstin: '27AAAAA0000A1Z0' }),
      doc({ number: 'BILL-1', kind: 'BILL' }),
      doc({ number: 'BILL-2', kind: 'BILL', gstin: gstin('27ABCDE1234F1Z'), supplierState: '27' }),
      doc({ number: 'INV-6', status: 'VOID', lines: [line({ igst: '1.00' })] }),
    ]);
    const by = (k: string) => found.filter((f) => f.kind === k).map((f) => f.documentNumber ?? f.message);
    expect(by('WRONG_TAX_HEADS')).toEqual(['INV-1', 'INV-2']);
    expect(by('CGST_SGST_UNEQUAL')).toEqual(['INV-3']);
    expect(by('TAX_ON_EXEMPT')).toEqual(['INV-3']);
    expect(by('TAX_NOT_AT_RATE')).toEqual(['INV-3']); // 170 is not 18% of 1,000
    expect(by('INVALID_GSTIN')).toEqual(['INV-5']);
    expect(by('ITC_WITHOUT_SUPPLIER_GSTIN')).toEqual(['BILL-1']);
    expect(by('GSTIN_STATE_MISMATCH')).toEqual([]);
    expect(by('MISSING_HSN')).toEqual(['INV-2']);
    expect(by('HSN_RATE_VARIES')[0]).toMatch(/^HSN 8471 was sold at different rates: 12% on INV-4; 18% on INV-1, INV-3, INV-5/);
    expect(found.map((f) => f.severity)).toEqual([...found.map((f) => f.severity)].sort((a, b) => ['HIGH', 'MEDIUM', 'LOW'].indexOf(a) - ['HIGH', 'MEDIUM', 'LOW'].indexOf(b)));
    expect(found.find((f) => f.kind === 'ITC_WITHOUT_SUPPLIER_GSTIN')!.amount).toBe('180.00');
    expect(found.some((f) => f.documentNumber === 'INV-6')).toBe(false);
  });

  it('flags a supplier GSTIN from another state, and leaves a clean document alone', () => {
    const valid = gstin('29AAACT2727Q1Z');
    const found = gstDiscrepancies([doc({ number: 'BILL-3', kind: 'BILL', gstin: valid, supplierState: '27' })]);
    expect(found.map((f) => f.kind)).toEqual(['GSTIN_STATE_MISMATCH']);
    expect(gstDiscrepancies([doc({ number: 'INV-7' })])).toEqual([]);
  });
});
