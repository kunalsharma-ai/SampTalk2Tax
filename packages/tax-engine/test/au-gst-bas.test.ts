import { describe, expect, it } from 'vitest';
import { auBasDueDate, auBasPeriodFor, auCorrectionAllowance, auGstBas, normaliseAbn, recentAuBasPeriods, suggestAuTreatment, vatJurisdiction, type VatEntry, type VatRateInfo } from '../src';

const rates: VatRateInfo[] = [
  { id: 't', name: 'GST 10%', rate: '10', treatment: null },
  { id: 'f', name: 'GST-free 0%', rate: '0', treatment: null },
  { id: 'i', name: 'Input taxed rent', rate: '0', treatment: null },
  { id: 'o', name: 'Out of scope', rate: '0', treatment: null },
];
const line = (source: VatEntry['source'], taxRateId: string | null, net: string, vat: string, extra: Partial<VatEntry> = {}): VatEntry => ({ source, id: `${source}-${net}`, number: 'X', date: '2026-08-15', taxRateId, rate: '10', net, vat, ...extra });

describe('Australian GST on the BAS', () => {
  it('checks the ABN', () => {
    expect(normaliseAbn('51 824 753 556')).toBe('51824753556');
    expect(normaliseAbn('53004085616')).toBe('53004085616');
    expect(normaliseAbn('51 824 753 557')).toBeNull();
    expect(normaliseAbn('5182475355')).toBeNull();
    expect(normaliseAbn('GB123456782')).toBeNull();
  });

  it('gives the BAS due dates', () => {
    expect(auBasDueDate('2026-09-30', false)).toBe('2026-10-28');
    expect(auBasDueDate('2026-12-31', false)).toBe('2027-02-28');
    expect(auBasDueDate('2027-03-31', false)).toBe('2027-04-28');
    expect(auBasDueDate('2027-06-30', false)).toBe('2027-07-28');
    expect(auBasDueDate('2026-08-31', true)).toBe('2026-09-21');
    expect(auBasDueDate('2026-12-31', true)).toBe('2027-01-21');
    expect(auBasPeriodFor('QUARTERLY_MAR', '2026-12-31')).toEqual({ start: '2026-10-01', end: '2026-12-31', due: '2027-02-28' });
    expect(auBasPeriodFor('QUARTERLY_APR', '2026-10-31')).toBeNull();
    expect(recentAuBasPeriods('MONTHLY', '2026-11-23', 2).map((p) => p.due)).toEqual(['2026-12-21', '2026-11-21']);
  });

  it('suggests treatments', () => {
    expect(suggestAuTreatment('10', 'GST 10%')).toBe('STANDARD');
    expect(suggestAuTreatment('0', 'GST-free 0%')).toBe('ZERO');
    expect(suggestAuTreatment('0', 'Input taxed rent')).toBe('EXEMPT');
    expect(suggestAuTreatment('0', 'No GST')).toBe('OUTSIDE_SCOPE');
    expect(suggestAuTreatment('15', 'Other')).toBeNull();
  });

  it('fills G1, 1A and 1B in whole dollars', () => {
    const r = auGstBas(
      [
        line('INVOICE', 't', '1000.40', '100.04'),
        line('INVOICE', 'f', '500.00', '0.00'),
        line('INVOICE', 'i', '300.00', '0.00'),
        line('INVOICE', 'o', '999.00', '0.00'),
        line('CREDIT_NOTE', 't', '100.00', '10.00'),
        line('BILL', 't', '400.00', '40.00'),
        line('BILL', 'f', '200.00', '0.00'),
        line('VENDOR_CREDIT', 't', '50.00', '5.00'),
        line('EXPENSE_CLAIM', 't', '20.00', '2.00'),
        line('BILL', 't', '80.00', '8.00', { reversal: true }),
      ],
      rates,
      { untaxed: 'OUTSIDE_SCOPE' },
    );
    // G1: 1100.44 taxable incl. GST + 500 + 300 − 110 credit note = 1790.44 → 1790.
    expect(r.boxes).toEqual({ G1: '1790', '1A': '90', '1B': '29', net: '61' });
    expect(r.direction).toBe('PAY');
    expect(r.own).toEqual({ output: '90.04', input: '29.00', supplies: '1790.44', purchases: '519.00' });
    expect(r.breakdown.map((b) => `${b.side}:${b.treatment}`)).toEqual(['SALES:STANDARD', 'SALES:ZERO', 'SALES:EXEMPT', 'SALES:OUTSIDE_SCOPE', 'PURCHASES:STANDARD', 'PURCHASES:ZERO']);
    expect(r.issues).toEqual([]);
  });

  it('adds corrections, reports a refund and asks for unknown rates', () => {
    const r = auGstBas([line('BILL', 't', '1000.00', '100.00'), line('INVOICE', 'x', '10.00', '1.50')], [...rates, { id: 'x', name: 'Odd 15%', rate: '15', treatment: null }, { id: 'r', name: 'Reduced', rate: '5', treatment: 'REDUCED' }], {
      untaxed: 'OUTSIDE_SCOPE',
      corrections: [{ output: '20.50', input: '0.00' }],
    });
    expect(r.boxes).toEqual({ G1: '0', '1A': '20', '1B': '100', net: '80' });
    expect(r.direction).toBe('RECLAIM');
    expect(r.issues[0]).toContain('Choose the GST treatment of Odd 15%');
    const warn = auGstBas([line('INVOICE', 'f', '10.00', '1.00')], rates, { untaxed: 'OUTSIDE_SCOPE' });
    expect(warn.warnings[0]).toContain('carries GST');
    const reduced = auGstBas([line('INVOICE', 'r', '10.00', '0.50')], [{ id: 'r', name: 'Reduced', rate: '5', treatment: 'REDUCED' }], { untaxed: 'OUTSIDE_SCOPE' });
    expect(reduced.issues[0]).toContain('Australia does not have');
  });

  it('allows corrections up to A$10,000 and is a jurisdiction', () => {
    expect(auCorrectionAllowance([{ output: '10000.00', input: '0' }]).allowed).toBe(true);
    expect(auCorrectionAllowance([{ output: '10000.01', input: '0' }]).allowed).toBe(false);
    const j = vatJurisdiction('AU')!;
    expect(j.returnName).toBe('Business activity statement (GST)');
    expect(j.staggers).toEqual(['MONTHLY', 'QUARTERLY_MAR']);
    expect(j.dueDate('2026-12-31', 'MONTHLY')).toBe('2027-01-21');
    expect(j.dueDate('2026-12-31', 'QUARTERLY_MAR')).toBe('2027-02-28');
    const r = j.compute([line('INVOICE', 't', '100.00', '10.00')], rates, { untaxed: 'OUTSIDE_SCOPE', revenue: '0', corrections: [] });
    expect(r.boxes[j.netBox]).toBe('10');
    expect(j.correctionMonths).toBe(18);
  });
});
