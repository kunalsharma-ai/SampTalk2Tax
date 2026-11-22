import { describe, expect, it } from 'vitest';
import { buildTaxReport, taxReportCsv, type TaxReportDocument } from '../src/tax-report';

const line = (taxRate: string, netAmount: string, taxAmount: string, heads: Partial<{ cgstAmount: string; sgstAmount: string; igstAmount: string }> = {}) => ({ taxRate, netAmount, taxAmount, cgstAmount: '0', sgstAmount: '0', igstAmount: '0', ...heads });
const doc = (kind: TaxReportDocument['kind'], issueDate: string, lines: TaxReportDocument['lines'], extra: Partial<TaxReportDocument> = {}): TaxReportDocument => ({ kind, issueDate, exchangeRate: '1', reverseChargeTax: '0', withholding: null, lines, ...extra });

const docs: TaxReportDocument[] = [
  doc('INVOICE', '2026-10-05', [line('18', '10000', '1800', { cgstAmount: '900', sgstAmount: '900' }), line('5', '2000', '100', { igstAmount: '100' })]),
  doc('INVOICE', '2026-11-02', [line('18', '100', '18', { igstAmount: '18' })], { exchangeRate: '84.5', withholding: { kind: 'TCS', section: '206C(1H)', base: '118', amount: '0.12' } }),
  doc('CREDIT_NOTE', '2026-11-10', [line('18', '1000', '180', { cgstAmount: '90', sgstAmount: '90' })]),
  doc('BILL', '2026-10-20', [line('18', '5000', '900', { cgstAmount: '450', sgstAmount: '450' })], { withholding: { kind: 'TDS', section: '194C', base: '5000', amount: '100' } }),
  doc('BILL', '2026-11-15', [line('0', '3000', '0')], { reverseChargeTax: '540', withholding: { kind: 'TDS', section: '194C', base: '3000', amount: '60' } }),
  doc('VENDOR_CREDIT', '2026-11-20', [line('18', '500', '90', { cgstAmount: '45', sgstAmount: '45' })]),
];

describe('tax reports (RPT-009)', () => {
  const r = buildTaxReport(docs, [{ code: '2310', name: 'GST Payable', subtype: 'TAX_PAYABLE', opening: '-1200', debit: '500', credit: '3200' }], 'INR');

  it('sums output and input tax by rate, less credit notes and vendor credits, converting foreign documents', () => {
    expect(r.documents).toBe(6);
    // Sales at 18%: 10000 + 8450 − 1000; tax 1800 + 1521 − 180.
    expect(r.byRate).toEqual([
      { rate: '0', sales: { taxable: '0.00', tax: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00' }, purchases: { taxable: '3000.00', tax: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00' }, net: '0.00' },
      { rate: '5', sales: { taxable: '2000.00', tax: '100.00', cgst: '0.00', sgst: '0.00', igst: '100.00' }, purchases: { taxable: '0.00', tax: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00' }, net: '100.00' },
      { rate: '18', sales: { taxable: '17450.00', tax: '3141.00', cgst: '810.00', sgst: '810.00', igst: '1521.00' }, purchases: { taxable: '4500.00', tax: '810.00', cgst: '405.00', sgst: '405.00', igst: '0.00' }, net: '2331.00' },
    ]);
    expect(r.totals).toMatchObject({ outputTax: '3241.00', inputTax: '810.00', net: '2431.00', reverseCharge: '540.00', tds: '160.00', tcs: '10.14' });
  });

  it('gives each month, the withholding by section and the tax accounts', () => {
    expect(r.byMonth).toEqual([
      { month: '2026-10', outputTax: '1900.00', inputTax: '900.00', net: '1000.00' },
      { month: '2026-11', outputTax: '1341.00', inputTax: '-90.00', net: '1431.00' },
    ]);
    expect(r.withholding).toEqual([
      { kind: 'TCS', section: '206C(1H)', base: '9971.00', amount: '10.14', documents: 1 },
      { kind: 'TDS', section: '194C', base: '8000.00', amount: '160.00', documents: 2 },
    ]);
    expect(r.accounts).toEqual([{ code: '2310', name: 'GST Payable', subtype: 'TAX_PAYABLE', opening: '-1200.00', debit: '500.00', credit: '3200.00', closing: '-3900.00' }]);
  });

  it('is empty without documents, and writes a CSV with formulas guarded', () => {
    const e = buildTaxReport([], [], 'INR');
    expect(e).toMatchObject({ documents: 0, byRate: [], byMonth: [], withholding: [], totals: { net: '0.00' } });
    const csv = taxReportCsv(buildTaxReport(docs, [{ code: '2310', name: '=CMD()', subtype: 'TAX_PAYABLE', opening: '0', debit: '0', credit: '0' }], 'INR'), { from: '2026-10-01', to: '2026-11-30', currency: 'INR' });
    const rows = csv.trim().split('\n');
    expect(rows[0]).toBe('Tax report,2026-10-01 to 2026-11-30,INR');
    expect(rows).toContain('18,17450.00,3141.00,4500.00,810.00,2331.00');
    expect(rows).toContain('2026-11,1341.00,-90.00,1431.00');
    expect(rows).toContain('TDS,194C,8000.00,160.00,2');
    expect(rows.at(-1)).toBe(`2310,"'=CMD()",0.00,0.00,0.00,0.00`);
  });
});
