import { describe, expect, it } from 'vitest';
import { caCorrectionAllowance, caGstHstDueDate, caGstHstPeriodFor, caGstHstReturn, normaliseCaBusinessNumber, recentCaGstHstPeriods, suggestCaTreatment, vatJurisdiction, type VatEntry, type VatRateInfo } from '../src';

const rates: VatRateInfo[] = [
  { id: 'g', name: 'GST 5% (federal)', rate: '5', treatment: null },
  { id: 'h', name: 'HST 13% (Ontario)', rate: '13', treatment: null },
  { id: 'z', name: 'GST 0% (zero-rated)', rate: '0', treatment: null },
  { id: 'e', name: 'Exempt rent', rate: '0', treatment: null },
  { id: 'o', name: 'Out of scope', rate: '0', treatment: null },
];
const line = (source: VatEntry['source'], taxRateId: string | null, net: string, vat: string, extra: Partial<VatEntry> = {}): VatEntry => ({ source, id: `${source}-${net}`, number: 'X', date: '2026-08-15', taxRateId, rate: '5', net, vat, ...extra });

describe('Canadian GST/HST return', () => {
  it('checks the business number', () => {
    expect(normaliseCaBusinessNumber('123456782 RT0001')).toBe('123456782RT0001');
    expect(normaliseCaBusinessNumber('123-456-782-rt-0002')).toBe('123456782RT0002');
    expect(normaliseCaBusinessNumber('123456783RT0001')).toBeNull();
    expect(normaliseCaBusinessNumber('123456782RC0001')).toBeNull();
    expect(normaliseCaBusinessNumber('123456782')).toBeNull();
  });

  it('is due one month after the period ends', () => {
    expect(caGstHstDueDate('2026-03-31')).toBe('2026-04-30');
    expect(caGstHstDueDate('2026-12-31')).toBe('2027-01-31');
    expect(caGstHstPeriodFor('QUARTERLY_MAR', '2026-09-30')).toEqual({ start: '2026-07-01', end: '2026-09-30', due: '2026-10-31' });
    expect(recentCaGstHstPeriods('MONTHLY', '2026-11-23', 2).map((p) => p.due)).toEqual(['2026-12-31', '2026-11-30']);
  });

  it('suggests GST and HST rates as taxable', () => {
    expect(['5', '13', '14', '15'].map((r) => suggestCaTreatment(r, 'x'))).toEqual(['STANDARD', 'STANDARD', 'STANDARD', 'STANDARD']);
    expect(suggestCaTreatment('0', 'Exempt rent')).toBe('EXEMPT');
    expect(suggestCaTreatment('0', 'Out of scope')).toBe('OUTSIDE_SCOPE');
    expect(suggestCaTreatment('0', 'Exports')).toBe('ZERO');
    expect(suggestCaTreatment('12', 'GST + PST BC')).toBeNull();
  });

  it('fills lines 101 to 109', () => {
    const r = caGstHstReturn(
      [
        line('INVOICE', 'g', '1000.00', '50.00'),
        line('INVOICE', 'h', '2000.00', '260.00'),
        line('INVOICE', 'z', '500.00', '0.00'),
        line('INVOICE', 'e', '300.00', '0.00'),
        line('CREDIT_NOTE', 'g', '100.00', '5.00'),
        line('BILL', 'h', '400.00', '52.00'),
        line('BILL', 'e', '200.00', '0.00'),
        line('VENDOR_CREDIT', 'g', '20.00', '1.00'),
        line('EXPENSE_CLAIM', 'g', '40.00', '2.00'),
      ],
      rates,
      { untaxed: 'OUTSIDE_SCOPE', revenue: '3700.50' },
    );
    expect(r.boxes).toEqual({ '101': '3701', '103': '305.00', '104': '0.00', '105': '305.00', '106': '53.00', '107': '0.00', '108': '53.00', '109': '252.00' });
    expect(r.direction).toBe('PAY');
    expect(r.own).toEqual({ output: '305.00', input: '53.00', supplies: '3700.00', purchases: '420.00' });
    expect(r.breakdown.find((b) => b.side === 'PURCHASES' && b.treatment === 'EXEMPT')?.counted).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it('claims missed ITCs, refunds and asks about other rates', () => {
    const r = caGstHstReturn([line('BILL', 'g', '1000.00', '50.00'), line('INVOICE', 'x', '10.00', '1.20')], [...rates, { id: 'x', name: 'GST + PST 12%', rate: '12', treatment: null }], { untaxed: 'OUTSIDE_SCOPE', revenue: '0', corrections: [{ output: '0', input: '7.50' }] });
    expect(r.boxes).toMatchObject({ '103': '0.00', '106': '57.50', '109': '57.50' });
    expect(r.direction).toBe('RECLAIM');
    expect(r.issues[0]).toContain('Choose the GST/HST treatment of GST + PST 12%');
    const odd = caGstHstReturn([line('INVOICE', 'p', '10.00', '1.20')], [{ id: 'p', name: 'GST + PST 12%', rate: '12', treatment: 'STANDARD' }], { untaxed: 'OUTSIDE_SCOPE', revenue: '10' });
    expect(odd.warnings[0]).toContain('PST and QST are not on this return');
  });

  it('carries only missed ITCs to a later return', () => {
    expect(caCorrectionAllowance([{ output: '0.00', input: '25.00' }]).allowed).toBe(true);
    expect(caCorrectionAllowance([{ output: '5.00', input: '25.00' }]).allowed).toBe(false);
    expect(caCorrectionAllowance([{ output: '0.00', input: '-1.00' }]).allowed).toBe(false);
    const j = vatJurisdiction('CA')!;
    expect(j).toMatchObject({ currency: 'CAD', netBox: '109', correctionMonths: 48, needsRevenue: true });
    expect(j.correctionRule).toContain('input tax credits missed');
  });
});
