import { describe, expect, it } from 'vitest';
import { explainDocumentTax, type TaxExplanationInput, type TaxExplanationInputLine } from '../src';

const line = (o: Partial<TaxExplanationInputLine> = {}): TaxExplanationInputLine => ({ lineNo: 1, description: 'Laptops', hsnCode: '8471', taxName: 'GST 18%', taxKind: 'GST', gstCategory: 'TAXABLE', taxRate: '18', netAmount: '1000.00', cgst: '90.00', sgst: '90.00', igst: '0.00', taxAmount: '180.00', rateRecord: { original: '18', inForce: '18', changedOn: null }, ...o });
const doc = (o: Partial<TaxExplanationInput> = {}): TaxExplanationInput => ({
  kind: 'INVOICE',
  number: 'INV-000001',
  issueDate: '2026-10-05',
  currency: 'INR',
  exchangeRate: '1',
  functionalCurrency: 'INR',
  contactName: 'Synthetic Buyer',
  gst: { placeOfSupply: '27', supplierState: '27', supplyNature: 'INTRA', counterpartyGstin: '27AAAPA1234A1Z5', orgState: '27' },
  reverseCharge: false,
  debitNoteFor: null,
  lines: [line()],
  withholding: null,
  ...o,
});

describe('tax explanations', () => {
  it('explains an intra-state sale line by line, with sources', () => {
    const e = explainDocumentTax(doc());
    expect(e.summary).toBe('Tax on this invoice: GST INR 180.00.');
    expect(e.points.map((p) => p.key)).toEqual(['place_of_supply', 'nature']);
    expect(e.points[0]!.text).toMatch(/^The place of supply is Maharashtra \(27\)/);
    expect(e.points[0]!.sources).toContainEqual({ kind: 'LAW', label: 'IGST Act, 2017, s.10 (goods) and s.12 (services)' });
    expect(e.points[1]).toMatchObject({ title: 'Intra-state: CGST and SGST' });
    expect(e.lines[0]!.text).toBe('INR 1000.00 at 18% = CGST 9% INR 90.00 and SGST 9% INR 90.00, each rounded on its own so the halves are equal.');
    expect(e.lines[0]!.sources).toContainEqual({ kind: 'BOOKS', label: 'HSN/SAC 8471' });
    expect(e.checks).toEqual([]);
  });

  it('explains inter-state, UTGST, exports, nil-rated, exempt and non-GST lines', () => {
    const inter = explainDocumentTax(doc({ gst: { placeOfSupply: '29', supplierState: '27', supplyNature: 'INTER', counterpartyGstin: null, orgState: '27' }, lines: [line({ cgst: '0.00', sgst: '0.00', igst: '180.00' }), line({ lineNo: 2, gstCategory: 'EXEMPT', taxRate: '0', cgst: '0.00', sgst: '0.00' }), line({ lineNo: 3, gstCategory: 'NIL_RATED', taxRate: '0', cgst: '0.00', sgst: '0.00' }), line({ lineNo: 4, gstCategory: 'NON_GST', taxRate: '0', cgst: '0.00', sgst: '0.00' })] }));
    expect(inter.points[1]!.title).toBe('Inter-state: IGST');
    expect(inter.lines.map((l) => l.text.split(':')[0]!.slice(0, 40))).toEqual(['INR 1000.00 at 18% = IGST INR 180.00.', 'INR 1000.00 is exempt from GST by notifi', 'INR 1000.00 is nil-rated', 'INR 1000.00 is outside GST (for example ']);
    const ut = explainDocumentTax(doc({ gst: { placeOfSupply: '04', supplierState: '04', supplyNature: 'INTRA', counterpartyGstin: null, orgState: '04' } }));
    expect(ut.points[1]!.title).toBe('Intra-state: CGST and UTGST');
    expect(ut.lines[0]!.text).toContain('UTGST 9%');
    const exp = explainDocumentTax(doc({ gst: { placeOfSupply: '96', supplierState: '27', supplyNature: 'INTER', counterpartyGstin: null, orgState: '27' }, lines: [line({ cgst: '0.00', sgst: '0.00', igst: '180.00' })] }));
    expect(exp.points[0]!.text).toMatch(/this is an export: a zero-rated supply/);
  });

  it('explains reverse charge, input credit, credit notes, rate changes, foreign currency and TDS, and says what to check', () => {
    const rcm = explainDocumentTax(doc({ kind: 'BILL', number: 'BILL-000001', contactName: 'Adv. Rao', reverseCharge: true, gst: { placeOfSupply: '27', supplierState: '27', supplyNature: 'INTRA', counterpartyGstin: null, orgState: '27' }, lines: [line({ hsnCode: '998211' })], withholding: { kind: 'TDS', code: '393(1)-6(i)', name: 'Contractors', rate: '2', subject: '1000.00', base: '31000.00', amount: '620.00', pan: null } }));
    expect(rcm.summary).toBe('Tax on this bill: GST INR 180.00 payable by you under reverse charge; TDS INR 620.00.');
    const rc = rcm.points.find((p) => p.key === 'reverse_charge')!;
    expect(rc.text).toMatch(/because it is legal services by an advocate, a notified category[\s\S]*you issue a self-invoice within 30 days/);
    expect(rc.sources.map((s) => s.label)).toContain('CGST Act, 2017, s.49(4) (paid in cash)');
    const tds = rcm.points.find((p) => p.key === 'withholding')!;
    expect(tds.text).toMatch(/^You deduct INR 620\.00 of income tax from what you pay Adv\. Rao: 2% on INR 31000\.00 under section 393\(1\)-6\(i\) \(Contractors\)\. The base is more than this bill \(INR 1000\.00\)[\s\S]*no PAN on file[\s\S]*due to the government by 2026-11-07/);
    expect(tds.sources[0]).toEqual({ kind: 'LAW', label: 'Income-tax Act 2025, s.393(1) Table Sl. No. 6(i)' });
    expect(rcm.lines[0]!.text).toContain('paid by you under reverse charge');

    const bill = explainDocumentTax(doc({ kind: 'VENDOR_CREDIT', gst: { placeOfSupply: '27', supplierState: '27', supplyNature: 'INTRA', counterpartyGstin: null, orgState: '27' }, currency: 'USD', exchangeRate: '83.25', lines: [line({ hsnCode: null, taxRate: '12', rateRecord: { original: '12', inForce: '18', changedOn: '2026-10-01' } })] }));
    expect(bill.points.map((p) => p.key)).toEqual(['place_of_supply', 'nature', 'input_credit', 'note', 'currency']);
    expect(bill.points.find((p) => p.key === 'currency')!.text).toContain('converted to INR at 83.25');
    expect(bill.lines[0]!.text).toContain('"GST 18%" was 12% when it was set up; 18% has been in force since 2026-10-01');
    expect(bill.checks).toEqual([
      'Synthetic Buyer has no GSTIN on this vendor credit, so the credit cannot be claimed.',
      'Line 1: enter the HSN or SAC code; the HSN/SAC is needed on the tax invoice and in GSTR-1.',
      'Line 1 uses 12%, but "GST 18%" was 18% on 2026-10-05.',
    ]);
  });

  it('explains a simple tax and a line without tax when there is no GST', () => {
    const e = explainDocumentTax(doc({ gst: null, lines: [line({ taxKind: 'SIMPLE', taxName: 'VAT 5%', taxRate: '5', taxAmount: '50.00', cgst: '0.00', sgst: '0.00', rateRecord: null }), line({ lineNo: 2, taxName: null, taxKind: null, taxAmount: '0.00', rateRecord: null })] }));
    expect(e.summary).toBe('Tax on this invoice: other tax INR 50.00.');
    expect(e.lines.map((l) => l.text)).toEqual(['INR 1000.00 at 5% = INR 50.00 (VAT 5%).', 'No tax rate on this line, so no tax.']);
    expect(e.basis).toMatch(/no AI model is used/);
  });
});
