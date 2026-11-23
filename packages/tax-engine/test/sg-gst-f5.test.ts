import { describe, expect, it } from 'vitest';
import { normaliseSgGstNumber, recentSgGstPeriods, sgCorrectionAllowance, sgGstDueDate, sgGstPeriodFor, sgGstReturn, suggestSgTreatment, taxPeriodChange, vatJurisdiction, type VatEntry, type VatRateInfo } from '../src';

const rates: VatRateInfo[] = [
  { id: 's', name: 'GST 9% (standard)', rate: '9', treatment: null },
  { id: 'z', name: 'GST 0% (zero-rated)', rate: '0', treatment: null },
  { id: 'e', name: 'Exempt financial services', rate: '0', treatment: null },
  { id: 'o', name: 'Out of scope', rate: '0', treatment: null },
];
const line = (source: VatEntry['source'], taxRateId: string | null, net: string, vat: string, extra: Partial<VatEntry> = {}): VatEntry => ({ source, id: `${source}-${net}`, number: 'X', date: '2026-06-15', taxRateId, rate: '9', net, vat, ...extra });

describe('Singapore GST F5', () => {
  it('checks the registration number format', () => {
    expect(normaliseSgGstNumber('2019-12345k')).toBe('201912345K');
    expect(normaliseSgGstNumber('53123456A')).toBe('53123456A');
    expect(normaliseSgGstNumber('T09LL0001B')).toBe('T09LL0001B');
    expect(normaliseSgGstNumber('M2 1234567 8')).toBe('M212345678');
    expect(normaliseSgGstNumber('MR8500012X')).toBe('MR8500012X');
    expect(normaliseSgGstNumber('GB123456782')).toBeNull();
    expect(normaliseSgGstNumber('12345')).toBeNull();
  });

  it('is due one month after the period ends', () => {
    expect(sgGstDueDate('2026-03-31')).toBe('2026-04-30');
    expect(sgGstDueDate('2026-01-31')).toBe('2026-02-28');
    expect(sgGstDueDate('2026-12-31')).toBe('2027-01-31');
    expect(sgGstPeriodFor('QUARTERLY_MAR', '2026-06-30')).toEqual({ start: '2026-04-01', end: '2026-06-30', due: '2026-07-31' });
    expect(recentSgGstPeriods('MONTHLY', '2026-11-23', 2).map((p) => p.due)).toEqual(['2026-12-31', '2026-11-30']);
  });

  it('suggests treatments, with 7% and 8% as earlier standard rates', () => {
    expect(['9', '8', '7'].map((r) => suggestSgTreatment(r, 'x'))).toEqual(['STANDARD', 'STANDARD', 'STANDARD']);
    expect(suggestSgTreatment('0', 'Exempt financial services')).toBe('EXEMPT');
    expect(suggestSgTreatment('0', 'Out of scope')).toBe('OUTSIDE_SCOPE');
    expect(suggestSgTreatment('0', 'Exports')).toBe('ZERO');
    expect(suggestSgTreatment('5', 'Reduced')).toBeNull();
  });

  it('fills the boxes from the lines and the revenue', () => {
    const r = sgGstReturn(
      [
        line('INVOICE', 's', '1000.00', '90.00'),
        line('INVOICE', 'z', '500.00', '0'),
        line('INVOICE', 'e', '200.00', '0'),
        line('INVOICE', 'o', '50.00', '0'),
        line('CREDIT_NOTE', 's', '100.00', '9.00'),
        line('BILL', 's', '400.00', '36.00'),
        line('BILL', 'z', '100.00', '0'),
        line('BILL', 'e', '70.00', '0'),
        line('EXPENSE_CLAIM', 's', '20.00', '1.80'),
        line('BILL', 's', '10.00', '0.90', { reversal: true }),
      ],
      rates,
      { untaxed: 'OUTSIDE_SCOPE', revenue: '1650.00' },
    );
    expect(r.boxes).toEqual({ box1: '900.00', box2: '500.00', box3: '200.00', box4: '1600.00', box5: '510.00', box6: '81.00', box7: '36.90', box8: '44.10', box13: '1650.00' });
    expect(r.direction).toBe('PAY');
    expect(r.own).toEqual({ output: '81.00', input: '36.90', supplies: '1600.00', purchases: '510.00' });
    expect(r.breakdown.find((b) => b.side === 'PURCHASES' && b.treatment === 'EXEMPT')).toMatchObject({ net: '70.00', counted: false });
    expect(r.issues).toEqual([]);
  });

  it('refuses reduced rates and unknown rates, and adds corrections to boxes 6 and 7', () => {
    const r = sgGstReturn([line('INVOICE', 'r', '100.00', '5.00'), line('BILL', 'q', '100.00', '12.00')], [{ id: 'r', name: 'Five', rate: '5', treatment: 'REDUCED' }, { id: 'q', name: 'Odd', rate: '12', treatment: null }], {
      untaxed: 'ZERO',
      revenue: '0',
      corrections: [{ output: '10.00', input: '2.00' }],
    });
    expect(r.issues).toEqual(['Five is set as reduced-rated, which Singapore does not have: choose another treatment', 'Choose the GST treatment of Odd (12%, 1 line)']);
    expect(r.boxes).toMatchObject({ box6: '10.00', box7: '2.00', box8: '8.00' });
  });

  it('allows corrections up to S$1,500 net GST', () => {
    expect(sgCorrectionAllowance([{ output: '1500.00', input: '0' }])).toEqual({ net: '1500.00', limit: '1500.00', allowed: true });
    expect(sgCorrectionAllowance([{ output: '0', input: '1500.01' }]).allowed).toBe(false);
  });
});

describe('jurisdictions', () => {
  it('knows the UK and Singapore returns, and none for India', () => {
    expect(vatJurisdiction('GB')).toMatchObject({ returnName: 'VAT return', netBox: 'box5', authority: 'HMRC' });
    expect(vatJurisdiction('SG')).toMatchObject({ returnName: 'GST return (F5)', netBox: 'box8', authority: 'IRAS', needsRevenue: true });
    expect(vatJurisdiction('IN')).toBeNull();
  });

  it('keeps the UK figures through the common shape', () => {
    const uk = vatJurisdiction('GB')!;
    const r = uk.compute([line('INVOICE', 's20', '100.00', '20.00')], [{ id: 's20', name: 'VAT 20%', rate: '20', treatment: null }], { untaxed: 'ZERO', revenue: '0', corrections: [{ periodEnd: '2026-03-31', output: '5.00', input: '1.00' }] });
    expect(r.boxes).toMatchObject({ box1: '25.00', box4: '1.00', box5: '24.00', box6: '100' });
    expect(r.own).toEqual({ output: '20.00', input: '0.00', supplies: '100.00', purchases: '0.00' });
    expect(uk.correctionAllowance([{ periodEnd: 'x', output: '20000', input: '0' }], { ...r.own, supplies: '3000000' })).toMatchObject({ limit: '30000.00', allowed: true });
  });

  it('finds changes to a submitted period, less corrections made', () => {
    expect(taxPeriodChange({ output: '100', input: '40' }, { output: '120', input: '40' }, [])).toEqual({ output: '20.00', input: '0.00', net: '20.00', changed: true });
    expect(taxPeriodChange({ output: '100', input: '40' }, { output: '120', input: '40' }, [{ output: '20', input: '0' }]).changed).toBe(false);
  });
});
