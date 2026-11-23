import { describe, expect, it } from 'vitest';
import { deCorrectionAllowance, deUstvaDueDate, deUstvaPeriodFor, deUstVoranmeldung, normaliseUstIdNr, recentDeUstvaPeriods, suggestDeTreatment, vatJurisdiction, type VatEntry, type VatRateInfo } from '../src';

const rates: VatRateInfo[] = [
  { id: 's', name: 'USt 19% (standard)', rate: '19', treatment: null },
  { id: 'r', name: 'USt 7% (reduced)', rate: '7', treatment: null },
  { id: 'z', name: 'USt 0%', rate: '0', treatment: null },
  { id: 'e', name: 'Exempt rent (§ 4 Nr. 12)', rate: '0', treatment: null },
];
const line = (source: VatEntry['source'], taxRateId: string | null, net: string, vat: string, extra: Partial<VatEntry> = {}): VatEntry => ({ source, id: `${source}-${net}`, number: 'X', date: '2026-08-15', taxRateId, rate: '19', net, vat, ...extra });

describe('German VAT advance return', () => {
  it('checks the USt-IdNr.', () => {
    expect(normaliseUstIdNr('de 136 695 976')).toBe('DE136695976');
    expect(normaliseUstIdNr('DE123456788')).toBe('DE123456788');
    expect(normaliseUstIdNr('DE136695977')).toBeNull();
    expect(normaliseUstIdNr('ATU13585627')).toBeNull();
  });

  it('is due on the 10th after the period', () => {
    expect(deUstvaDueDate('2026-03-31')).toBe('2026-04-10');
    expect(deUstvaDueDate('2026-12-31')).toBe('2027-01-10');
    expect(deUstvaPeriodFor('QUARTERLY_MAR', '2026-09-30')).toEqual({ start: '2026-07-01', end: '2026-09-30', due: '2026-10-10' });
    expect(deUstvaPeriodFor('QUARTERLY_APR', '2026-10-31')).toBeNull();
    expect(recentDeUstvaPeriods('MONTHLY', '2026-11-23', 2).map((p) => p.due)).toEqual(['2026-12-10', '2026-11-10']);
  });

  it('suggests treatments, with 7% reduced', () => {
    expect(suggestDeTreatment('19', 'x')).toBe('STANDARD');
    expect(suggestDeTreatment('7', 'x')).toBe('REDUCED');
    expect(suggestDeTreatment('0', 'Exempt rent (§ 4 Nr. 12)')).toBe('EXEMPT');
    expect(suggestDeTreatment('0', 'Nicht steuerbar')).toBe('OUTSIDE_SCOPE');
    expect(suggestDeTreatment('0', 'Ausfuhr')).toBe('ZERO');
    expect(suggestDeTreatment('16', 'Old rate')).toBeNull();
  });

  it('fills the Kennzahlen, with the tax worked out from whole-euro bases', () => {
    const r = deUstVoranmeldung(
      [
        line('INVOICE', 's', '1000.80', '190.15'),
        line('INVOICE', 'r', '500.00', '35.00'),
        line('INVOICE', 'z', '300.50', '0.00'),
        line('INVOICE', 'e', '200.00', '0.00'),
        line('CREDIT_NOTE', 's', '100.00', '19.00'),
        line('BILL', 's', '400.00', '76.00'),
        line('BILL', 'r', '100.00', '7.00'),
        line('BILL', 'e', '50.00', '0.00'),
        line('VENDOR_CREDIT', 's', '10.00', '1.90'),
      ],
      rates,
      { untaxed: 'OUTSIDE_SCOPE' },
    );
    // Kz 81 = 900.80 → 900, tax 171.00; Kz 86 = 500, tax 35.00; Kz 66 = 76 + 7 − 1.90 = 81.10; Kz 83 = 206 − 81.10.
    expect(r.boxes).toEqual({ '81': '900', '81-vat': '171.00', '86': '500', '86-vat': '35.00', '43': '300', '48': '200', '66': '81.10', '83': '124.90', output: '206.00' });
    expect(r.direction).toBe('PAY');
    expect(r.own).toMatchObject({ output: '206.00', input: '81.10' });
    expect(r.warnings).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('warns when invoice VAT differs from the form and asks about other rates', () => {
    const r = deUstVoranmeldung([line('INVOICE', 's', '1000.00', '160.00'), line('INVOICE', 'x', '10.00', '1.60')], [...rates, { id: 'x', name: 'Old 16%', rate: '16', treatment: null }], { untaxed: 'OUTSIDE_SCOPE' });
    expect(r.warnings.some((w) => w.includes('differs by more than EUR 1'))).toBe(true);
    expect(r.issues[0]).toContain('Choose the VAT treatment of Old 16%');
  });

  it('never carries corrections to a later return', () => {
    expect(deCorrectionAllowance([]).allowed).toBe(true);
    expect(deCorrectionAllowance([{ output: '1.00', input: '0' }]).allowed).toBe(false);
    const j = vatJurisdiction('DE')!;
    expect(j).toMatchObject({ currency: 'EUR', netBox: '83', outputBox: 'output', inputBox: '66' });
    expect(j.boxOrder).not.toContain('output');
    expect(j.correctionRule).toContain('berichtigte Voranmeldung');
  });
});
