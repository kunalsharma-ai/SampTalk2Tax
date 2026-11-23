import { describe, expect, it } from 'vitest';
import { financialYearOf, type GstReturnDocument, reverseChargeCategory, reverseChargeRegister, selfInvoiceIssues, selfInvoiceNumber } from '../src';

const line = (o: Partial<GstReturnDocument['lines'][number]> = {}) => ({ hsnCode: '998211', quantity: '1', category: 'TAXABLE' as const, rate: '18', taxable: '10000.00', cgst: '900.00', sgst: '900.00', igst: '0.00', ...o });
const doc = (o: Partial<GstReturnDocument>): GstReturnDocument => ({ id: o.number ?? 'x', kind: 'BILL', status: 'POSTED', number: 'BILL-1', issueDate: '2026-10-05', contactName: 'Synthetic Advocate', gstin: null, placeOfSupply: '27', nature: 'INTRA', total: '10000.00', reverseCharge: true, supplierState: '27', lines: [line()], ...o });

describe('reverse charge categories', () => {
  it('matches the longest notified HSN/SAC prefix and nothing else', () => {
    expect(reverseChargeCategory('998211')?.key).toBe('LEGAL');
    expect(reverseChargeCategory('9965 11')?.key).toBe('GTA');
    expect(reverseChargeCategory('996791')?.key).toBe('GTA');
    expect(reverseChargeCategory('997212')?.key).toBe('COMMERCIAL_RENT');
    expect(reverseChargeCategory('72044900')?.key).toBe('METAL_SCRAP');
    expect(reverseChargeCategory('8471')).toBeNull();
    expect(reverseChargeCategory(null)).toBeNull();
  });

  it('numbers self-invoices per financial year', () => {
    expect(financialYearOf('2026-03-31')).toBe('2025-26');
    expect(financialYearOf('2026-04-01')).toBe('2026-27');
    expect(selfInvoiceNumber('2026-27', 7)).toBe('RCM/2026-27/0007');
  });
});

describe('reverse charge register', () => {
  it('totals bills less vendor credits, tracks self-invoices and points out bills that may have missed reverse charge', () => {
    const docs = [
      doc({ number: 'BILL-1' }),
      doc({ number: 'BILL-2', issueDate: '2026-10-20', gstin: '27AAAPA1234A1Z5', contactName: 'Registered GTA', lines: [line({ hsnCode: '996511', taxable: '5000.00', cgst: '125.00', sgst: '125.00' })] }),
      doc({ number: 'BILL-3', supplierState: '96', nature: 'INTER', contactName: 'Overseas Software Inc', lines: [line({ hsnCode: '998313', cgst: '0.00', sgst: '0.00', igst: '1800.00' })] }),
      doc({ number: 'VC-1', kind: 'VENDOR_CREDIT', lines: [line({ taxable: '1000.00', cgst: '90.00', sgst: '90.00' })] }),
      doc({ number: 'BILL-4', status: 'VOID' }),
      doc({ number: 'BILL-5', reverseCharge: false, gstin: '27AAACS1234B1Z1', contactName: 'Guard Services', lines: [line({ hsnCode: '8471' }), line({ hsnCode: '998525' })] }),
      doc({ number: 'BILL-6', reverseCharge: false, gstin: '27AAACM1234C1Z2', contactName: 'Registered Scrap Co', lines: [line({ hsnCode: '7204' })] }),
    ];
    const r = reverseChargeRegister(docs, new Map([['BILL-1', { number: 'RCM/2026-27/0001', issuedOn: '2026-10-06' }]]), '2026-11-10');
    expect(r.rows.map((x) => x.number)).toEqual(['BILL-1', 'BILL-2', 'BILL-3', 'VC-1']);
    expect(r.totals).toEqual({ taxable: '24000.00', igst: '1800.00', cgst: '935.00', sgst: '935.00', tax: '3670.00' });
    expect(r.rows[0]!.selfInvoice).toEqual({ required: true, number: 'RCM/2026-27/0001', issuedOn: '2026-10-06', dueBy: '2026-11-04', overdue: false });
    expect(r.rows[1]!.selfInvoice).toEqual({ required: false, number: null, issuedOn: null, dueBy: null, overdue: false });
    expect(r.rows[1]!.categories).toEqual([{ key: 'GTA', title: 'Goods transport agency (GTA)' }]);
    expect(r.rows[2]).toMatchObject({ importOfServices: true, categories: [], selfInvoice: { required: true, overdue: true } });
    expect(r.rows[3]).toMatchObject({ kind: 'VENDOR_CREDIT', selfInvoice: { required: false } });
    expect(r.selfInvoices).toEqual({ required: 2, issued: 1, overdue: 1 });
    // The registered scrap dealer is left alone: scrap is under reverse charge only from unregistered suppliers.
    expect(r.possiblyMissed.map((m) => [m.number, m.category.key, m.hsnCode, m.taxCharged])).toEqual([['BILL-5', 'SECURITY', '998525', '1800.00']]);
  });

  it('says why a self-invoice cannot be issued', () => {
    expect(selfInvoiceIssues(doc({}), null, '2026-10-06', '2026-11-10')).toEqual([]);
    expect(selfInvoiceIssues(doc({ gstin: '27AAAPA1234A1Z5' }), null, '2026-10-06', '2026-11-10')).toEqual(['The supplier is registered, so their own tax invoice is the document; no self-invoice is needed']);
    expect(selfInvoiceIssues(doc({ kind: 'VENDOR_CREDIT', status: 'VOID' }), { number: 'RCM/2026-27/0001', issuedOn: '2026-10-06' }, '2026-10-01', '2026-10-02')).toEqual([
      'Self-invoices are issued for bills, not vendor credits',
      'BILL-1 is void',
      'Self-invoice RCM/2026-27/0001 was already issued on 2026-10-06',
      'A self-invoice cannot be dated before the bill (2026-10-05)',
    ]);
    expect(selfInvoiceIssues(doc({ reverseCharge: false }), null, '2026-12-01', '2026-11-10')).toEqual(['BILL-1 is not under reverse charge', 'A self-invoice cannot be dated in the future']);
  });
});
