import { describe, expect, it } from 'vitest';
import { gstinCheckCharacter } from '../src/india/gstin';
import { supplierTaxIssues, type SupplierFacts } from '../src/india/supplier-checks';

const g = (first14: string) => first14 + gstinCheckCharacter(first14);
const GSTIN = g('27AAACR5055K1Z');
const base: SupplierFacts = { name: 'Rathi Steel Pvt Ltd', gstin: GSTIN, stateCode: '27', pan: 'AAACR5055K', tdsSection: null, sameGstin: [], samePan: [], verification: { status: 'ACTIVE', taxpayerType: 'REGULAR', checkedOn: '2026-10-01', legalName: 'RATHI STEEL PRIVATE LIMITED', effectiveDate: null }, bills: [] };
const bill = (number: string, o: Partial<SupplierFacts['bills'][number]> = {}) => ({ number, date: '2026-10-10', gstin: GSTIN, supplierState: '27', placeOfSupply: '27', reverseCharge: false, cgst: '90.00', sgst: '90.00', igst: '0.00', ...o });
const codes = (f: Partial<SupplierFacts>, today = '2026-11-10') => supplierTaxIssues({ ...base, ...f }, today).map((i) => i.code);

describe('supplier tax checks', () => {
  it('finds nothing wrong with a clean, recently checked vendor', () => {
    expect(codes({ bills: [bill('BILL-1'), bill('BILL-2', { placeOfSupply: '29', cgst: '0', sgst: '0', igst: '180.00' })] })).toEqual([]);
  });

  it('checks the GSTIN, PAN and state against each other', () => {
    expect(codes({ gstin: '27AAACR5055K1ZX' })).toContain('GSTIN_INVALID');
    expect(codes({ stateCode: '29' })).toEqual(['STATE_MISMATCH']);
    expect(codes({ pan: 'AAACR5056K' })).toEqual(['PAN_MISMATCH']);
    expect(codes({ gstin: null, pan: 'ABC', verification: null })).toEqual(['PAN_INVALID']);
    expect(codes({ gstin: null, pan: null, tdsSection: '194C', verification: null })).toEqual(['TDS_NO_PAN']);
  });

  it('flags the same GSTIN or PAN on other vendors', () => {
    const i = supplierTaxIssues({ ...base, sameGstin: ['Rathi Steel (old)'], samePan: ['Rathi Steel (old)'] }, '2026-11-10');
    expect(i.map((x) => x.code)).toEqual(['DUPLICATE_GSTIN']);
    expect(codes({ samePan: ['Rathi Steel Karnataka'] })).toEqual(['DUPLICATE_PAN']);
  });

  it('checks the GST on bills', () => {
    const noGstin = supplierTaxIssues({ ...base, gstin: null, verification: null, bills: [bill('B-1', { gstin: null }), bill('B-2', { gstin: null, reverseCharge: true }), bill('B-3', { gstin: null, cgst: '0', sgst: '0' })] }, '2026-11-10');
    expect(noGstin).toEqual([expect.objectContaining({ code: 'GST_WITHOUT_GSTIN', severity: 'HIGH', bills: ['B-1'] })]);
    expect(codes({ bills: [bill('B-1', { gstin: null })] })).toEqual(['BILL_WITHOUT_GSTIN']);
    expect(codes({ bills: [bill('B-1', { gstin: g('27AAACR5055K2Z') })] })).toEqual(['BILL_GSTIN_CHANGED']);
    const head = supplierTaxIssues({ ...base, bills: [bill('B-1', { cgst: '0', sgst: '0', igst: '180' }), bill('B-2', { placeOfSupply: '29' }), bill('B-3')] }, '2026-11-10');
    expect(head).toEqual([expect.objectContaining({ code: 'WRONG_TAX_HEAD', bills: ['B-1', 'B-2'] })]);
  });

  it('uses the recorded portal check: cancelled, composition, stale, name', () => {
    const cancelled = supplierTaxIssues({ ...base, verification: { ...base.verification!, status: 'CANCELLED', effectiveDate: '2026-10-05' }, bills: [bill('B-1', { date: '2026-10-01' }), bill('B-2', { date: '2026-10-06' })] }, '2026-11-10');
    expect(cancelled[0]).toMatchObject({ code: 'REGISTRATION_CANCELLED', severity: 'HIGH', bills: ['B-2'] });
    expect(cancelled[0]!.message).toContain('from 5 Oct 2026');
    expect(codes({ verification: { ...base.verification!, taxpayerType: 'COMPOSITION' }, bills: [bill('B-1')] })).toEqual(['COMPOSITION_CHARGED_GST']);
    expect(codes({ verification: { ...base.verification!, taxpayerType: 'COMPOSITION' }, bills: [bill('B-1', { cgst: '0', sgst: '0' })] })).toEqual([]);
    expect(codes({ verification: null })).toEqual(['NOT_VERIFIED']);
    expect(codes({}, '2027-04-01')).toEqual(['VERIFICATION_STALE']);
    expect(codes({ verification: { ...base.verification!, legalName: 'Shree Ganesh Traders' } })).toEqual(['NAME_DIFFERS']);
  });
});

describe('supplier check messages', () => {
  it('give dates as people read them and agree in number', () => {
    const one = supplierTaxIssues({ ...base, verification: { ...base.verification!, status: 'CANCELLED', effectiveDate: '2026-10-05' }, bills: [bill('B-1', { date: '2026-10-06' })] }, '2026-11-10');
    expect(one[0]!.message).toMatch(/^On 1 Oct 2026 the GST portal showed this GSTIN as cancelled from 5 Oct 2026\..* One bill with GST is dated from then\.$/);
    const stale = supplierTaxIssues(base, '2027-06-01').find((i) => i.code === 'VERIFICATION_STALE');
    expect(stale!.message).toContain('on 1 Oct 2026, more than 180 days ago');
  });
});
