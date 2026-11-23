import { describe, expect, it } from 'vitest';
import { aeCorrectionAllowance, aeVat201, aeVatDueDate, aeVatPeriodFor, normaliseTrn, recentAeVatPeriods, suggestAeTreatment, vatJurisdiction, type VatEntry, type VatRateInfo } from '../src';

const rates: VatRateInfo[] = [
  { id: 's', name: 'VAT 5%', rate: '5', treatment: null },
  { id: 'z', name: 'VAT 0% (zero-rated)', rate: '0', treatment: null },
  { id: 'e', name: 'Exempt residential rent', rate: '0', treatment: null },
  { id: 'o', name: 'Out of scope', rate: '0', treatment: null },
];
const line = (source: VatEntry['source'], taxRateId: string | null, net: string, vat: string, extra: Partial<VatEntry> = {}): VatEntry => ({ source, id: `${source}-${net}`, number: 'X', date: '2026-08-15', taxRateId, rate: '5', net, vat, ...extra });

describe('UAE VAT 201', () => {
  it('checks the TRN', () => {
    expect(normaliseTrn('100 1234 5678 9003')).toBe('100123456789003');
    expect(normaliseTrn('100-123456789003')).toBe('100123456789003');
    expect(normaliseTrn('200123456789003')).toBe(null);
    expect(normaliseTrn('10012345678900')).toBe(null);
  });

  it('is due 28 days after the period ends', () => {
    expect(aeVatDueDate('2026-03-31')).toBe('2026-04-28');
    expect(aeVatDueDate('2026-12-31')).toBe('2027-01-28');
    expect(aeVatDueDate('2027-01-31')).toBe('2027-02-28');
    expect(aeVatPeriodFor('QUARTERLY_APR', '2026-10-31')).toEqual({ start: '2026-08-01', end: '2026-10-31', due: '2026-11-28' });
    expect(recentAeVatPeriods('MONTHLY', '2026-11-23', 2).map((p) => p.due)).toEqual(['2026-12-28', '2026-11-28']);
  });

  it('suggests treatments', () => {
    expect(suggestAeTreatment('5', 'VAT 5%')).toBe('STANDARD');
    expect(suggestAeTreatment('0', 'Exempt residential rent')).toBe('EXEMPT');
    expect(suggestAeTreatment('0', 'Out of scope')).toBe('OUTSIDE_SCOPE');
    expect(suggestAeTreatment('0', 'Exports')).toBe('ZERO');
    expect(suggestAeTreatment('15', 'KSA VAT')).toBeNull();
  });

  it('fills the boxes, with supplies in the business emirate', () => {
    const r = aeVat201(
      [
        line('INVOICE', 's', '10000.00', '500.00'),
        line('INVOICE', 'z', '3000.00', '0.00'),
        line('INVOICE', 'e', '2000.00', '0.00'),
        line('INVOICE', 'o', '999.00', '0.00'),
        line('CREDIT_NOTE', 's', '1000.00', '50.00'),
        line('BILL', 's', '4000.00', '200.00'),
        line('BILL', 'e', '500.00', '0.00'),
        line('VENDOR_CREDIT', 's', '200.00', '10.00'),
        line('EXPENSE_CLAIM', 's', '100.00', '5.00'),
      ],
      rates,
      { untaxed: 'OUTSIDE_SCOPE', emirate: 'DU' },
    );
    expect(r.boxes).toMatchObject({ '1a': '0.00', '1b': '9000.00', '1b-vat': '450.00', '1c-vat': '0.00', '4': '3000.00', '5': '2000.00', '8': '14000.00', '8-vat': '450.00', '9': '3900.00', '9-vat': '195.00', '11': '3900.00', '11-vat': '195.00', '12': '450.00', '13': '195.00', '14': '255.00' });
    expect(r.direction).toBe('PAY');
    expect(r.own).toEqual({ output: '450.00', input: '195.00', supplies: '14000.00', purchases: '3900.00' });
    expect(r.issues).toEqual([]);
  });

  it('adds corrections and asks for the emirate', () => {
    const r = aeVat201([line('BILL', 's', '1000.00', '50.00')], rates, { untaxed: 'OUTSIDE_SCOPE', emirate: 'AD', corrections: [{ output: '20.00', input: '0' }] });
    expect(r.boxes).toMatchObject({ '8-vat': '20.00', '12': '20.00', '13': '50.00', '14': '30.00' });
    expect(r.direction).toBe('RECLAIM');
    expect(aeVat201([line('INVOICE', 's', '100.00', '5.00')], rates, { untaxed: 'OUTSIDE_SCOPE', emirate: null }).issues[0]).toBe('Choose the emirate your business is established in, for boxes 1a to 1g');
  });

  it('allows corrections up to AED 10,000 and is a jurisdiction', () => {
    expect(aeCorrectionAllowance([{ output: '10000.00', input: '0' }]).allowed).toBe(true);
    expect(aeCorrectionAllowance([{ output: '0', input: '10000.01' }]).allowed).toBe(false);
    const j = vatJurisdiction('AE')!;
    expect(j).toMatchObject({ currency: 'AED', netBox: '14', correctionMonths: 60 });
    expect(j.region?.options.map((o) => o.key)).toEqual(['AD', 'DU', 'SH', 'AJ', 'UQ', 'RK', 'FU']);
  });
});

describe('VAT 201 box order', () => {
  it('lists 1a to 1g before 4, 5 and the totals', () => {
    const j = vatJurisdiction('AE')!;
    expect(j.boxOrder?.slice(0, 3)).toEqual(['1a', '1a-vat', '1b']);
    expect(j.boxOrder?.at(-1)).toBe('14');
    expect([...(j.boxOrder ?? [])].sort()).toEqual(Object.keys(j.boxLabels).sort());
  });
});
