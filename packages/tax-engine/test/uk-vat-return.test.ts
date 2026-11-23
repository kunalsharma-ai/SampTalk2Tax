import { describe, expect, it } from 'vitest';
import { normaliseVrn, recentVatPeriods, suggestVatTreatment, ukVatReturn, vatCorrectionAllowance, vatPeriodChange, vatPeriodFor, vatReturnCsv, type VatEntry, type VatRateInfo } from '../src';

const rates: VatRateInfo[] = [
  { id: 's', name: 'VAT 20% (standard)', rate: '20', treatment: null },
  { id: 'r', name: 'VAT 5% (reduced)', rate: '5', treatment: null },
  { id: 'z', name: 'VAT 0% (zero-rated)', rate: '0', treatment: null },
  { id: 'e', name: 'Exempt', rate: '0', treatment: 'EXEMPT' },
  { id: 'o', name: 'Wages and transfers', rate: '0', treatment: 'OUTSIDE_SCOPE' },
];
const line = (source: VatEntry['source'], taxRateId: string | null, net: string, vat: string, extra: Partial<VatEntry> = {}): VatEntry => ({ source, id: `${source}-${net}`, number: 'X', date: '2026-06-15', taxRateId, rate: '0', net, vat, ...extra });

describe('VAT periods', () => {
  it('follows the stagger and the due date of one month and seven days', () => {
    expect(vatPeriodFor('QUARTERLY_MAR', '2026-06-30')).toEqual({ start: '2026-04-01', end: '2026-06-30', due: '2026-08-07' });
    expect(vatPeriodFor('QUARTERLY_MAR', '2026-03-31')?.due).toBe('2026-05-07');
    expect(vatPeriodFor('QUARTERLY_APR', '2027-01-31')).toEqual({ start: '2026-11-01', end: '2027-01-31', due: '2027-03-07' });
    expect(vatPeriodFor('QUARTERLY_MAY', '2027-02-28')).toEqual({ start: '2026-12-01', end: '2027-02-28', due: '2027-04-07' });
    expect(vatPeriodFor('MONTHLY', '2026-11-30')).toEqual({ start: '2026-11-01', end: '2026-11-30', due: '2027-01-07' });
    expect(vatPeriodFor('QUARTERLY_MAR', '2026-05-31')).toBeNull();
    expect(vatPeriodFor('MONTHLY', '2026-11-29')).toBeNull();
  });

  it('lists the periods that have started, newest first', () => {
    expect(recentVatPeriods('QUARTERLY_MAR', '2026-11-23', 3).map((p) => p.end)).toEqual(['2026-12-31', '2026-09-30', '2026-06-30']);
    expect(recentVatPeriods('QUARTERLY_APR', '2026-11-23', 2).map((p) => `${p.start}..${p.end}`)).toEqual(['2026-11-01..2027-01-31', '2026-08-01..2026-10-31']);
    expect(recentVatPeriods('MONTHLY', '2026-11-01', 2).map((p) => p.end)).toEqual(['2026-11-30', '2026-10-31']);
  });
});

describe('VAT registration numbers', () => {
  it('checks modulus 97 and its 9755 variant', () => {
    expect(normaliseVrn('GB 123 4567 82')).toBe('GB123456782');
    expect(normaliseVrn('123456727')).toBe('GB123456727');
    expect(normaliseVrn('123456782001')).toBe('GB123456782001');
    expect(normaliseVrn('123456783')).toBeNull();
    expect(normaliseVrn('GB12345678')).toBeNull();
    expect(normaliseVrn('FR123456782')).toBeNull();
  });
});

describe('the nine boxes', () => {
  it('suggests treatments from the rate', () => {
    expect(suggestVatTreatment('20', 'Sales')).toBe('STANDARD');
    expect(suggestVatTreatment('5.000000', 'Energy')).toBe('REDUCED');
    expect(suggestVatTreatment('0', 'Exempt insurance')).toBe('EXEMPT');
    expect(suggestVatTreatment('0', 'No VAT')).toBe('OUTSIDE_SCOPE');
    expect(suggestVatTreatment('0', 'Exports')).toBe('ZERO');
    expect(suggestVatTreatment('12.5', 'Old rate')).toBeNull();
  });

  it('adds sales and purchases by treatment, credit notes and voids taking off', () => {
    const r = ukVatReturn(
      [
        line('INVOICE', 's', '1000.00', '200.00'),
        line('INVOICE', 'r', '200.00', '10.00'),
        line('INVOICE', 'z', '300.55', '0'),
        line('INVOICE', 'e', '100.00', '0'),
        line('INVOICE', 'o', '999.00', '0'),
        line('CREDIT_NOTE', 's', '100.00', '20.00'),
        line('BILL', 's', '400.00', '80.00'),
        line('VENDOR_CREDIT', 's', '50.00', '10.00'),
        line('EXPENSE_CLAIM', 's', '60.00', '12.00'),
        line('BILL', 's', '100.00', '20.00', { reversal: true }),
        line('BILL', null, '25.00', '0'),
      ],
      rates,
      { untaxed: 'OUTSIDE_SCOPE' },
    );
    // Output: 200 + 10 - 20 = 190; input: 80 - 10 + 12 - 20 = 62.
    expect(r.boxes).toEqual({ box1: '190.00', box2: '0.00', box3: '190.00', box4: '62.00', box5: '128.00', box6: '1500', box7: '310', box8: '0', box9: '0' });
    expect(r.direction).toBe('PAY');
    // Box 6: 1000 + 200 + 300.55 + 100 - 100 = 1500.55, pence left off.
    expect(r.own).toEqual({ box1: '190.00', box4: '62.00', box6: '1500.55', box7: '310.00' });
    expect(r.breakdown.find((b) => b.side === 'SALES' && b.treatment === 'OUTSIDE_SCOPE')).toMatchObject({ net: '999.00', counted: false });
    expect(r.issues).toEqual([]);
    expect(r.warnings).toEqual(['1 line has no tax rate and is treated as outside the scope of VAT']);
  });

  it('holds back rates without a treatment and reclaims when input is larger', () => {
    const r = ukVatReturn([line('BILL', 's', '500.00', '100.00'), line('INVOICE', 'x', '100.00', '12.50')], [...rates, { id: 'x', name: 'Old 12.5%', rate: '12.5', treatment: null }], { untaxed: 'ZERO' });
    expect(r.issues).toEqual(['Choose the VAT treatment of Old 12.5% (12.5%, 1 line)']);
    expect(r.boxes).toMatchObject({ box1: '0.00', box4: '100.00', box5: '100.00' });
    expect(r.direction).toBe('RECLAIM');
  });

  it('flags a rate set against its UK percentage', () => {
    const r = ukVatReturn([line('INVOICE', 'q', '100.00', '17.50')], [{ id: 'q', name: 'Old standard', rate: '17.5', treatment: 'STANDARD' }], { untaxed: 'ZERO' });
    expect(r.warnings).toEqual(['Old standard is 17.5% but set as standard rate, which is 20% in the UK']);
  });

  it('adds corrections of earlier periods to boxes 1 and 4', () => {
    const r = ukVatReturn([line('INVOICE', 's', '100.00', '20.00')], rates, { untaxed: 'ZERO', corrections: [{ periodEnd: '2026-03-31', box1: '40.00', box4: '5.00' }] });
    expect(r.boxes).toMatchObject({ box1: '60.00', box3: '60.00', box4: '5.00', box5: '55.00' });
    expect(r.own.box1).toBe('20.00');
  });
});

describe('corrections', () => {
  it('finds what changed in a filed period, less what was corrected already', () => {
    const filed = { box1: '100.00', box4: '40.00', box6: '500.00', box7: '200.00' };
    expect(vatPeriodChange(filed, filed, [])).toMatchObject({ changed: false });
    expect(vatPeriodChange(filed, { ...filed, box1: '140.00', box4: '45.00' }, [])).toEqual({ box1: '40.00', box4: '5.00', net: '35.00', changed: true });
    expect(vatPeriodChange(filed, { ...filed, box1: '140.00', box4: '45.00' }, [{ box1: '40.00', box4: '5.00' }])).toMatchObject({ changed: false });
  });

  it('allows £10,000, or 1% of box 6 up to £50,000', () => {
    expect(vatCorrectionAllowance([{ box1: '10000.00', box4: '0' }], '100000')).toEqual({ net: '10000.00', limit: '10000.00', allowed: true });
    expect(vatCorrectionAllowance([{ box1: '10000.01', box4: '0' }], '100000').allowed).toBe(false);
    expect(vatCorrectionAllowance([{ box1: '0', box4: '30000' }], '3000000')).toEqual({ net: '-30000.00', limit: '30000.00', allowed: true });
    expect(vatCorrectionAllowance([{ box1: '50000.01', box4: '0' }], '9000000')).toMatchObject({ limit: '50000.00', allowed: false });
  });
});

it('writes the boxes and entries as CSV', () => {
  const r = ukVatReturn([line('INVOICE', 's', '100.00', '20.00', { number: 'INV, 1' })], rates, { untaxed: 'ZERO' });
  const csv = vatReturnCsv({ start: '2026-04-01', end: '2026-06-30' }, r.boxes, [{ ...line('INVOICE', 's', '100.00', '20.00', { number: 'INV, 1' }), treatment: 'STANDARD' }]);
  expect(csv).toContain('1,VAT due on sales and other outputs,20.00');
  expect(csv).toContain('INVOICE,"INV, 1",2026-06-15,,STANDARD,0,100.00,20.00');
});
