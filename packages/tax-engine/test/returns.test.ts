import { describe, expect, it } from 'vitest';
import { GstReturnDocument, GstReturnLine, gstr1Summary, gstr3bSummary, setOffItc } from '../src';

const line = (taxable: string, rate: string, heads: Partial<Pick<GstReturnLine, 'cgst' | 'sgst' | 'igst'>>, extra: Partial<GstReturnLine> = {}): GstReturnLine => ({
  hsnCode: '8471',
  quantity: '1',
  category: 'TAXABLE',
  rate,
  taxable,
  cgst: heads.cgst ?? '0',
  sgst: heads.sgst ?? '0',
  igst: heads.igst ?? '0',
  ...extra,
});
let n = 0;
const doc = (p: Partial<GstReturnDocument> & Pick<GstReturnDocument, 'kind' | 'lines' | 'total'>): GstReturnDocument => ({
  id: `d${++n}`,
  status: 'POSTED',
  number: `${p.kind === 'INVOICE' ? 'INV' : p.kind === 'CREDIT_NOTE' ? 'CN' : 'BILL'}-${String(n).padStart(6, '0')}`,
  issueDate: '2026-10-05',
  contactName: 'X',
  gstin: null,
  placeOfSupply: '29',
  nature: 'INTRA',
  ...p,
});

describe('GSTR-1', () => {
  const docs = [
    doc({ kind: 'INVOICE', gstin: '27AAPFU0939F1ZV', placeOfSupply: '27', nature: 'INTER', total: '1180.00', lines: [line('1000.00', '18', { igst: '180.00' })] }),
    doc({ kind: 'INVOICE', placeOfSupply: '27', nature: 'INTER', total: '236000.00', lines: [line('200000.00', '18', { igst: '36000.00' })] }),
    doc({ kind: 'INVOICE', placeOfSupply: '27', nature: 'INTER', total: '59000.00', lines: [line('50000.00', '18', { igst: '9000.00' })] }),
    doc({ kind: 'INVOICE', total: '1150.00', lines: [line('1000.00', '5', { cgst: '25.00', sgst: '25.00' }, { hsnCode: '998314', quantity: '2' }), line('100.00', '0', {}, { category: 'NIL_RATED', hsnCode: '0401' })] }),
    doc({ kind: 'CREDIT_NOTE', total: '105.00', lines: [line('100.00', '5', { cgst: '2.50', sgst: '2.50' }, { hsnCode: '998314' })] }),
    doc({ kind: 'CREDIT_NOTE', gstin: '27AAPFU0939F1ZV', placeOfSupply: '27', nature: 'INTER', total: '118.00', lines: [line('100.00', '18', { igst: '18.00' })] }),
    doc({ kind: 'INVOICE', status: 'VOID', total: '500.00', lines: [line('500.00', '0', {}, { category: 'EXEMPT' })] }),
    doc({ kind: 'BILL', gstin: '29ZZZCZ0001Z1ZX', total: '118.00', lines: [line('100.00', '18', { cgst: '9.00', sgst: '9.00' })] }),
    doc({ kind: 'INVOICE', placeOfSupply: '96', nature: 'INTER', total: '236000.00', lines: [line('200000.00', '18', { igst: '36000.00' })] }),
  ];
  const r = gstr1Summary(docs);

  it('reports exports in their own table, never as B2CL or B2CS', () => {
    expect(r.exp.map((x) => [x.placeOfSupply, x.value])).toEqual([['96', '236000.00']]);
    expect(r.b2cl.every((x) => x.placeOfSupply !== '96')).toBe(true);
    expect(r.b2cs.every((x) => x.placeOfSupply !== '96')).toBe(true);
  });

  it('sorts invoices into B2B, B2CL and B2CS', () => {
    expect(r.b2b.map((x) => [x.gstin, x.value, x.rates])).toEqual([['27AAPFU0939F1ZV', '1180.00', [{ rate: '18', taxable: '1000.00', igst: '180.00', cgst: '0.00', sgst: '0.00' }]]]);
    expect(r.b2cl.map((x) => x.value)).toEqual(['236000.00']);
    // The 59,000 inter-state invoice is below Rs 1 lakh, so it is aggregated; the intra-state credit note nets against its B2CS row.
    expect(r.b2cs).toEqual([
      { placeOfSupply: '27', nature: 'INTER', rate: '18', taxable: '50000.00', igst: '9000.00', cgst: '0.00', sgst: '0.00' },
      { placeOfSupply: '29', nature: 'INTRA', rate: '5', taxable: '900.00', igst: '0.00', cgst: '22.50', sgst: '22.50' },
    ]);
  });

  it('honours a different B2CL threshold', () => {
    expect(gstr1Summary(docs, { b2clThreshold: '250000' }).b2cl).toEqual([]);
  });

  it('lists registered credit notes and leaves bills out', () => {
    expect(r.cdnr.map((x) => [x.number, x.value])).toEqual([[docs[5].number, '118.00']]);
    expect(r.cdnur).toEqual([]);
    expect(r.totals).toEqual({ taxable: '451800.00', igst: '81162.00', cgst: '22.50', sgst: '22.50' });
  });

  it('reports nil-rated supplies, HSN totals net of credit notes, and documents issued', () => {
    expect(r.nil).toEqual([{ nature: 'INTRA', registered: false, nilRated: '100.00', exempt: '0.00', nonGst: '0.00' }]);
    expect(r.hsn.b2b).toEqual([{ hsnCode: '8471', rate: '18', quantity: '0', taxable: '900.00', igst: '162.00', cgst: '0.00', sgst: '0.00' }]);
    expect(r.hsn.b2c.find((h) => h.hsnCode === '998314')).toEqual({ hsnCode: '998314', rate: '5', quantity: '1', taxable: '900.00', igst: '0.00', cgst: '22.50', sgst: '22.50' });
    expect(r.documents).toEqual([
      { kind: 'INVOICE', from: docs[0].number, to: docs[8].number, issued: 6, cancelled: 1 },
      { kind: 'CREDIT_NOTE', from: docs[4].number, to: docs[5].number, issued: 2, cancelled: 0 },
    ]);
  });
});

describe('ITC set-off', () => {
  it('uses IGST credit first, then each head against itself, then against IGST', () => {
    const s = setOffItc({ igst: '1000', cgst: '500', sgst: '500' }, { igst: '1200', cgst: '100', sgst: '600' });
    // IGST credit: 1000 to IGST; 200 left goes to CGST, where own credit (100) falls short by 400.
    expect(s.used.igst).toEqual({ igst: '1000.00', cgst: '200.00', sgst: '0.00' });
    expect(s.used.cgst).toEqual({ igst: '0.00', cgst: '100.00', sgst: '0.00' });
    expect(s.used.sgst).toEqual({ igst: '0.00', cgst: '0.00', sgst: '500.00' });
    expect(s.cash).toEqual({ igst: '0.00', cgst: '200.00', sgst: '0.00' });
    expect(s.carryForward).toEqual({ igst: '0.00', cgst: '0.00', sgst: '100.00' });
  });

  it('never uses CGST credit for SGST, and pays IGST from CGST and SGST credit', () => {
    const s = setOffItc({ igst: '300', cgst: '0', sgst: '400' }, { igst: '0', cgst: '500', sgst: '0' });
    expect(s.used.cgst).toEqual({ igst: '300.00', cgst: '0.00', sgst: '0.00' });
    expect(s.cash).toEqual({ igst: '0.00', cgst: '0.00', sgst: '400.00' });
    expect(s.carryForward.cgst).toBe('200.00');
  });

  it('must exhaust IGST credit before CGST and SGST credit', () => {
    const s = setOffItc({ igst: '0', cgst: '100', sgst: '100' }, { igst: '150', cgst: '100', sgst: '100' });
    expect(s.used.igst.cgst).toBe('100.00');
    expect(s.used.igst.sgst).toBe('50.00');
    expect(s.carryForward).toEqual({ igst: '0.00', cgst: '100.00', sgst: '50.00' });
    expect(s.cash).toEqual({ igst: '0.00', cgst: '0.00', sgst: '0.00' });
  });
});

describe('GSTR-3B', () => {
  it('nets credit notes, takes ITC from bills net of vendor credits, and sets off', () => {
    const docs = [
      doc({ kind: 'INVOICE', total: '11800.00', lines: [line('10000.00', '18', { cgst: '900.00', sgst: '900.00' }), line('500.00', '0', {}, { category: 'EXEMPT' })] }),
      doc({ kind: 'INVOICE', placeOfSupply: '07', nature: 'INTER', total: '5900.00', lines: [line('5000.00', '18', { igst: '900.00' }), line('50.00', '0', {}, { category: 'NON_GST' })] }),
      doc({ kind: 'CREDIT_NOTE', total: '1180.00', lines: [line('1000.00', '18', { cgst: '90.00', sgst: '90.00' })] }),
      doc({ kind: 'BILL', gstin: '27AAPFU0939F1ZV', nature: 'INTER', total: '2360.00', lines: [line('2000.00', '18', { igst: '360.00' }), line('300.00', '0', {}, { category: 'NIL_RATED' })] }),
      doc({ kind: 'VENDOR_CREDIT', gstin: '27AAPFU0939F1ZV', nature: 'INTER', total: '118.00', lines: [line('100.00', '18', { igst: '18.00' })] }),
      doc({ kind: 'BILL', status: 'VOID', gstin: '29ZZZCZ0001Z1ZX', total: '1180.00', lines: [line('1000.00', '18', { cgst: '90.00', sgst: '90.00' })] }),
      doc({ kind: 'INVOICE', placeOfSupply: '96', nature: 'INTER', total: '1180.00', lines: [line('1000.00', '18', { igst: '180.00' })] }),
    ];
    const r = gstr3bSummary(docs);
    expect(r.outwardZeroRated).toEqual({ taxable: '1000.00', igst: '180.00' });
    expect(r.outwardTaxable).toEqual({ taxable: '14000.00', igst: '900.00', cgst: '810.00', sgst: '810.00' });
    expect(r.outwardNilExempt).toBe('500.00');
    expect(r.outwardNonGst).toBe('50.00');
    expect(r.interStateUnregistered).toEqual([{ placeOfSupply: '07', taxable: '5000.00', igst: '900.00' }]);
    expect(r.itc).toEqual({ igst: '342.00', cgst: '0.00', sgst: '0.00' });
    expect(r.inwardExempt).toEqual({ inter: '300.00', intra: '0.00' });
    expect(r.setOff.cash).toEqual({ igst: '738.00', cgst: '810.00', sgst: '810.00' });
    expect(r.warnings).toEqual([]);
  });

  it('reports reverse-charge purchases in 3.1(d) and 4(A)(2)/(3), and pays their tax in cash', () => {
    const docs = [
      doc({ kind: 'INVOICE', total: '11800.00', lines: [line('10000.00', '18', { cgst: '900.00', sgst: '900.00' })] }),
      // Legal services from an advocate (reverse charge, intra-state).
      doc({ kind: 'BILL', reverseCharge: true, supplierState: '29', total: '20000.00', lines: [line('20000.00', '18', { cgst: '1800.00', sgst: '1800.00' }, { hsnCode: '998211' })] }),
      // Software subscription from a supplier outside India (import of services).
      doc({ kind: 'BILL', reverseCharge: true, supplierState: '96', nature: 'INTER', total: '5000.00', lines: [line('5000.00', '18', { igst: '900.00' }, { hsnCode: '997331' })] }),
      doc({ kind: 'BILL', gstin: '29ZZZCZ0001Z1ZX', total: '1180.00', lines: [line('1000.00', '18', { cgst: '90.00', sgst: '90.00' })] }),
    ];
    const r = gstr3bSummary(docs);
    expect(r.inwardReverseCharge).toEqual({ taxable: '25000.00', igst: '900.00', cgst: '1800.00', sgst: '1800.00' });
    expect(r.itcImportServices).toEqual({ igst: '900.00', cgst: '0.00', sgst: '0.00' });
    expect(r.itcReverseCharge).toEqual({ igst: '0.00', cgst: '1800.00', sgst: '1800.00' });
    expect(r.itc).toEqual({ igst: '0.00', cgst: '90.00', sgst: '90.00' });
    expect(r.itcTotal).toEqual({ igst: '900.00', cgst: '1890.00', sgst: '1890.00' });
    expect(r.reverseChargeCash).toEqual({ igst: '900.00', cgst: '1800.00', sgst: '1800.00' });
    // Forward-charge 900/900 is fully covered by credit (IGST credit is used first, rule 88A); the rest carries forward.
    expect(r.setOff.cash).toEqual({ igst: '0.00', cgst: '0.00', sgst: '0.00' });
    expect(r.setOff.carryForward).toEqual({ igst: '0.00', cgst: '1890.00', sgst: '990.00' });
  });
});
