import { describe, expect, it } from 'vitest';
import { addDays } from '../src/documents';
import { negotiationBrief, negotiationItemKey, type NegotiationBill, type NegotiationInput } from '../src/supplier-negotiation';

const T = '2026-11-22';
let n = 0;
/** A bill issued `ago` days before T, due 30 days later, paid `late` days after the due date (null: open). */
const bill = (ago: number, lines: NegotiationBill['lines'], late: number | null = 0, rate = '1'): NegotiationBill => {
  const issueDate = addDays(T, -ago);
  const dueDate = addDays(issueDate, 30);
  const subtotal = lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice), 0).toFixed(2); // not money (test fixture)
  return { id: `b${++n}`, issueDate, dueDate, exchangeRate: rate, subtotal, paidOn: late == null ? null : addDays(dueDate, late), lines };
};
const steel = (quantity: string, unitPrice: string) => ({ description: 'Steel sheet 2mm', hsnCode: '7208', quantity, unitPrice });
const base = (over: Partial<NegotiationInput>): NegotiationInput => ({
  vendor: { id: 'v1', name: 'Asha Steel', paymentTermsDays: 30 },
  bills: [],
  credits: '0',
  previousSpend: '0',
  totalSpend: '0',
  market: [],
  grade: null,
  today: T,
  currency: 'INR',
  ...over,
});

describe('supplier negotiation (AP-033)', () => {
  it('keys items by HSN code, else by tidied description', () => {
    expect(negotiationItemKey({ hsnCode: ' 72 08 ', description: 'x' })).toBe('hsn:7208');
    expect(negotiationItemKey({ hsnCode: null, description: '  Packing   Tape, 48mm! ' })).toBe('desc:packing tape 48mm');
    expect(negotiationItemKey({ hsnCode: '', description: '  ' })).toBeNull();
  });

  it('finds a price rise, a cheaper vendor, volume and a good payment record', () => {
    const b = negotiationBrief(
      base({
        bills: [bill(300, [steel('100', '50')]), bill(200, [steel('100', '55')]), bill(100, [steel('100', '55')]), bill(400, [steel('100', '40')])],
        previousSpend: '10000',
        totalSpend: '40000',
        market: [
          { vendorId: 'v2', vendorName: 'Bharat Metals', key: 'hsn:7208', issueDate: addDays(T, -250), unitPrice: '49' },
          { vendorId: 'v2', vendorName: 'Bharat Metals', key: 'hsn:7208', issueDate: addDays(T, -50), unitPrice: '52' },
          { vendorId: 'v3', vendorName: 'Old Mill', key: 'hsn:7208', issueDate: addDays(T, -500), unitPrice: '30' },
        ],
      }),
    );
    expect(b.spend).toEqual({ current: '16000.00', previous: '10000.00', change: '60.0', share: '40.0', bills: 3 });
    expect(b.payments).toEqual({ record: 'GOOD', paid: 3, onTime: 3, onTimePercent: 100, averageDaysLate: 0, overdue: 0 });
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ key: 'hsn:7208', label: 'Steel sheet 2mm', bills: 3, quantity: '300', spend: '16000.00', firstPrice: '50.00', latestPrice: '55.00', priceChange: '10.0', extraPaid: '1000.00', cheaperSaving: '900.00' });
    // Bharat's latest price counts, not its older lower one; Old Mill is outside the year.
    expect(b.items[0]!.bestOther).toMatchObject({ vendorName: 'Bharat Metals', unitPrice: '52.00', gap: '5.5' });
    expect(b.points.map((p) => p.code)).toEqual(['PRICE_RISE', 'CHEAPER_ELSEWHERE', 'VOLUME', 'GOOD_PAYER']);
    expect(b.points[0]!.detail).toContain('from INR 50.00 on 2026-01-26 to INR 55.00 on 2026-08-14');
    expect(b.points[2]!.detail).toBe('In the last twelve months your spend rose 60.0% to INR 16,000.00 on the year before, and they take 40.0% of everything you buy. Ask for a volume discount or a rate card for the coming year.');
    expect(b.points[3]!.detail).toContain('Ask for 45 days instead of 30');
    // The two savings overlap: the larger counts.
    expect(b.targetSaving).toBe('1000.00');
  });

  it('warns about late payment and weak performance, and stays quiet on small changes', () => {
    const b = negotiationBrief(
      base({
        bills: [bill(300, [steel('10', '100')], 10), bill(200, [steel('10', '102')], 5), bill(150, [steel('10', '103')], 0), bill(10, [steel('10', '103')], null), bill(60, [steel('10', '103')], null)],
        previousSpend: '5000',
        totalSpend: '100000',
        grade: 'D',
        market: [{ vendorId: 'v2', vendorName: 'Bharat Metals', key: 'hsn:7208', issueDate: addDays(T, -30), unitPrice: '101' }],
      }),
    );
    expect(b.payments).toMatchObject({ record: 'POOR', paid: 3, onTime: 1, onTimePercent: 33.3, averageDaysLate: 5, overdue: 1 });
    expect(b.items[0]).toMatchObject({ priceChange: '3.0', cheaperSaving: '0.00', bestOther: { gap: '1.9' } });
    expect(b.points.map((p) => [p.code, p.tone])).toEqual([['PAYS_LATE', 'CAUTION'], ['WEAK_PERFORMANCE', 'ASK']]);
    expect(b.points[0]!.detail).toBe('2 of 3 paid bills were paid late, and 1 bill is overdue now. The vendor will raise this, so clear what is overdue before asking for better prices or terms.');
    expect(b.targetSaving).toBe('0.00');
  });

  it('converts foreign bills and takes credits off the spend', () => {
    const b = negotiationBrief(base({ bills: [bill(20, [{ description: 'Design hours', hsnCode: null, quantity: '10', unitPrice: '12.5' }], 0, '83.25')], credits: '500', totalSpend: '9906.25' }));
    expect(b.spend).toMatchObject({ current: '9906.25', change: null, share: '100.0' });
    expect(b.items[0]).toMatchObject({ key: 'desc:design hours', latestPrice: '1040.62', priceChange: null });
    expect(b.payments.record).toBe('NONE');
    expect(b.points.map((p) => p.code)).toEqual(['VOLUME']);
  });
});
