import { describe, expect, it } from 'vitest';
import { classifyTaxDocument, readTaxDocument, taxDocumentYear } from '../src';

const FORM_16A = `FORM NO. 16A
[See rule 31(1)(b)]
Certificate under section 203 of the Income-tax Act, 1961 for tax deducted at source
Certificate No. KLMNOPQ
Name of the Deductor: Synthetic Buyer Private Limited
TAN of the Deductor: MUMS12345A
PAN of the Deductee: AAPFU0939F
Assessment Year 2026-27
Quarter Q3
Section 194J
Amount paid/credited 1,00,000.00
Amount of tax deducted 10,000.00
Amount of tax deposited 8,000.00`;

const FORM_26AS = `Annual Tax Statement (Form 26AS)
Permanent Account Number (PAN) AAPFU0939F
Assessment Year 2026-27
PART-I - Details of Tax Deducted at Source
Sr. No. | Name of Deductor | TAN of Deductor | Total Amount Paid / Credited | Total Tax Deducted | Total TDS Deposited
1 | SYNTHETIC BUYER PRIVATE LIMITED | MUMS12345A | 100000.00 | 10000.00 | 10000.00
2 | SYNTHETIC RETAIL LLP | DELS54321B | 50,000.00 | 1,000.00 | 1,000.00`;

const CHALLAN = `Form GST PMT-06
Challan for deposit of goods and services tax
CPIN: 26112700012345
Date of generation: 24/11/2026
GSTIN: 27AAPFU0939F1ZV
IGST Tax 0.00 0.00 0.00 0.00 0.00 5,000.00
CGST Tax 0.00 0.00 0.00 0.00 0.00 2,500.00
SGST(UTGST) Tax 0.00 0.00 0.00 0.00 0.00 2,500.00
Cess 0.00
Total Challan Amount: 10,000.00`;

const FORM_1099 = `Form 1099-NEC Nonemployee Compensation
For calendar year 2026
PAYER'S name: Synthetic Payer Inc
PAYER'S TIN 12-3456789
RECIPIENT'S TIN ***-**-4321
1 Nonemployee compensation $ 18,500.00
4 Federal income tax withheld $ 0.00`;

describe('tax document reading', () => {
  it('recognises each kind', () => {
    expect([FORM_16A, FORM_26AS, CHALLAN, FORM_1099, 'Dear customer, thank you'].map(classifyTaxDocument)).toEqual(['TDS_CERTIFICATE', 'ANNUAL_TAX_STATEMENT', 'GST_CHALLAN', 'FORM_1099', 'UNKNOWN']);
  });

  it('reads a TDS certificate and checks it', () => {
    const r = readTaxDocument(FORM_16A, { ownPan: 'AAPFU0939F' });
    const v = Object.fromEntries(r.fields.map((f) => [f.key, f.value]));
    expect(v).toMatchObject({
      deductorName: 'Synthetic Buyer Private Limited',
      deductorTan: 'MUMS12345A',
      deducteePan: 'AAPFU0939F',
      assessmentYear: '2026-27',
      quarter: 'Q3',
      section: '194J',
      amountPaid: '100000.00',
      taxDeducted: '10000.00',
      taxDeposited: '8000.00',
    });
    expect(r.fields.find((f) => f.key === 'deductorTan')!.line).toBe('TAN of the Deductor: MUMS12345A');
    expect(r.checks.map((c) => c.level)).toEqual(['OK', 'OK', 'WARNING']);
    expect(r.checks[1]!.message).toContain('10%');
    expect(taxDocumentYear(r)).toBe('2025-26');
    expect(taxDocumentYear({ fields: [{ key: 'taxYear', label: 'Tax year', value: '2026-27', line: '' }] })).toBe('2026-27');
    expect(readTaxDocument(FORM_16A, { ownPan: 'ZZZPZ9999Z' }).checks[0]!.level).toBe('ERROR');
  });

  it('reads the annual statement and compares it with the books', () => {
    const r = readTaxDocument(FORM_26AS, { ownPan: 'AAPFU0939F', booksTds: '10000.00' });
    expect(r.deductors.map((d) => [d.name, d.tan, d.amountPaid, d.taxDeducted, d.taxDeposited])).toEqual([
      ['SYNTHETIC BUYER PRIVATE LIMITED', 'MUMS12345A', '100000.00', '10000.00', '10000.00'],
      ['SYNTHETIC RETAIL LLP', 'DELS54321B', '50000.00', '1000.00', '1000.00'],
    ]);
    expect(r.totals).toMatchObject({ amountPaid: '150000.00', taxDeducted: '11000.00', taxDeposited: '11000.00' });
    expect(r.checks).toEqual([{ level: 'WARNING', message: expect.stringContaining('1000.00 more TDS than your TDS receivable') }]);
    expect(readTaxDocument(FORM_26AS, { booksTds: '12000' }).checks[0]!.level).toBe('ERROR');
  });

  it('reads a GST challan and adds up its heads', () => {
    const r = readTaxDocument(CHALLAN, { ownGstin: '27AAPFU0939F1ZV' });
    const v = Object.fromEntries(r.fields.map((f) => [f.key, f.value]));
    expect(v).toMatchObject({ cpin: '26112700012345', gstin: '27AAPFU0939F1ZV', date: '2026-11-24', igst: '5000.00', cgst: '2500.00', sgst: '2500.00', cess: '0.00', total: '10000.00' });
    expect(r.checks.map((c) => `${c.level}:${c.message.split(' ').slice(0, 4).join(' ')}`)).toEqual(['OK:The challan is for', 'OK:The tax heads add', 'WARNING:No CIN was found,']);
  });

  it('reads a 1099 received and leaves unknown text alone', () => {
    const r = readTaxDocument(FORM_1099, { ownEinLast4: '4321' });
    expect(Object.fromEntries(r.fields.map((f) => [f.key, f.value]))).toMatchObject({
      form: '1099-NEC',
      year: '2026',
      payer: 'Synthetic Payer Inc',
      payerTin: '12-3456789',
      recipientTin: '***-**-4321',
      nonemployeeCompensation: '18500.00',
      federalTaxWithheld: '0.00',
    });
    expect(r.totals.total).toBe('18500.00');
    expect(r.checks).toEqual([]);
    const u = readTaxDocument('Dear customer, thank you');
    expect(u).toMatchObject({ kind: 'UNKNOWN', fields: [], deductors: [], checks: [] });
  });
});
