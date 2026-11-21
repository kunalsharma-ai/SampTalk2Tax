import { describe, expect, it } from 'vitest';
import { addDays } from '../src/documents';
import { backtestPredictions, delayBand, delayProfile, predictDelay, predictionSummary, predictOpenInvoices, type PaidInvoiceForPrediction } from '../src/payment-predictions';

const T = '2026-11-21';
/** An invoice paid `paidAgo` days before T, `late` days after its due date. */
const paid = (contactId: string, paidAgo: number, late: number, total = '1000.00'): PaidInvoiceForPrediction => {
  const paidOn = addDays(T, -paidAgo);
  const dueDate = addDays(paidOn, -late);
  return { contactId, issueDate: addDays(dueDate, -30), dueDate, paidOn, total };
};

describe('delay bands and profiles', () => {
  it('bands days late', () => {
    expect([0, 5, 6, 30, 31].map(delayBand)).toEqual(['ON_TIME', 'ON_TIME', 'LATE', 'LATE', 'VERY_LATE']);
  });

  it('weights recent payments more and leaves out old and future ones', () => {
    const p = delayProfile([paid('a', 10, 20), paid('a', 190, 0), paid('a', 900, 50), paid('a', -5, 0)], T)!;
    expect(p.invoices).toBe(2);
    // The recent one (paid 10 days after due, 10 days ago) weighs ~1, the other (190 ago) ~0.48.
    expect(p.daysLate).toBeGreaterThan(13);
    expect(p.daysLate).toBeLessThan(14);
    expect(p.lateShare).toBeCloseTo(p.daysLate / 20, 5);
    expect(delayProfile([], T)).toBeNull();
  });
});

describe('predicting one invoice', () => {
  const inv = { id: 'i1', contactId: 'a', dueDate: addDays(T, 10) };
  it('uses a customer with long history mostly on their own record', () => {
    const own = Array.from({ length: 8 }, (_, k) => paid('a', 20 + k * 10, 20));
    const org = [...own, ...Array.from({ length: 20 }, (_, k) => paid('b', 20 + k * 5, 0))];
    const p = predictDelay({ invoice: inv, customerHistory: own, orgHistory: org, asOf: T })!;
    expect(p.confidence).toBe('HIGH');
    expect(p.basedOn).toBe(8);
    expect(p.expectedDaysLate).toBeGreaterThanOrEqual(14);
    expect(p.expectedDaysLate).toBeLessThanOrEqual(20);
    expect(p.band).toBe('LATE');
    expect(p.predictedPayDate).toBe(addDays(inv.dueDate, p.expectedDaysLate));
    expect(p.lateChance).toBeGreaterThan(60);
    expect(p.reasons[0]).toBe('Paid 8 invoices 20 days late on average');
  });

  it('leans on the organisation average for a new customer, and says so', () => {
    const org = Array.from({ length: 5 }, (_, k) => paid('b', 30 + k, 12));
    const p = predictDelay({ invoice: inv, customerHistory: [], orgHistory: org, asOf: T })!;
    expect(p).toMatchObject({ confidence: 'ORG_AVERAGE', basedOn: 0, expectedDaysLate: 12, band: 'LATE', lateChance: 100 });
    expect(p.reasons).toEqual(["No paid invoices from this customer yet: uses the organisation's average of 12 days late"]);
    const few = predictDelay({ invoice: inv, customerHistory: [paid('a', 20, 0)], orgHistory: [...org, paid('a', 20, 0)], asOf: T })!;
    expect(few.confidence).toBe('LOW');
    expect(few.expectedDaysLate).toBeLessThan(12);
    expect(few.reasons[1]).toMatch(/^Little history/);
  });

  it('gives nothing when nobody has paid yet', () => {
    expect(predictDelay({ invoice: inv, customerHistory: [], orgHistory: [], asOf: T })).toBeNull();
  });

  it('moves the estimate when a customer is paying slower lately', () => {
    const own = [paid('a', 300, 0), paid('a', 250, 0), paid('a', 200, 0), paid('a', 40, 30), paid('a', 20, 30)];
    const p = predictDelay({ invoice: inv, customerHistory: own, orgHistory: own, asOf: T })!;
    const flat = predictDelay({ invoice: inv, customerHistory: own.slice(3), orgHistory: own.slice(3), asOf: T })!;
    expect(p.reasons.some((r) => r.startsWith('Paying slower lately: 30 days late in the last 90 days, against 0 before'))).toBe(true);
    expect(p.expectedDaysLate).toBeGreaterThan(20);
    expect(flat.reasons.some((r) => r.startsWith('Paying slower'))).toBe(false);
  });

  it('treats a past-due invoice as late for certain, expected at least a week from today', () => {
    const own = Array.from({ length: 6 }, (_, k) => paid('a', 40 + k * 10, 0));
    const p = predictDelay({ invoice: { ...inv, dueDate: addDays(T, -20) }, customerHistory: own, orgHistory: own, asOf: T })!;
    expect(p).toMatchObject({ daysPastDue: 20, expectedDaysLate: 27, predictedPayDate: addDays(T, 7), lateChance: 100, band: 'LATE' });
    expect(p.reasons.at(-1)).toBe('Already 20 days past due');
  });

  it('raises the chance when another invoice of the customer is long overdue', () => {
    const own = Array.from({ length: 6 }, (_, k) => paid('a', 40 + k * 10, 0));
    const p = predictDelay({ invoice: inv, customerHistory: own, orgHistory: own, asOf: T, otherOverdueDays: 45 })!;
    expect(p.lateChance).toBe(80);
    expect(p.reasons).toContain('Another invoice to this customer is 45 days overdue');
  });
});

describe('open invoices, summary and backtest', () => {
  const history = [...Array.from({ length: 12 }, (_, k) => paid('a', 20 + k * 15, 0)), ...Array.from({ length: 4 }, (_, k) => paid('b', 20 + k * 15, 40))];
  const open = [
    { id: 'a1', contactId: 'a', issueDate: T, dueDate: addDays(T, 20), total: '5000.00', outstanding: '5000.00' },
    { id: 'b1', contactId: 'b', issueDate: addDays(T, -60), dueDate: addDays(T, -35), total: '8000.00', outstanding: '3000.00' },
    { id: 'b2', contactId: 'b', issueDate: T, dueDate: addDays(T, 30), total: '2000.50', outstanding: '2000.50' },
    { id: 'paid', contactId: 'b', issueDate: T, dueDate: addDays(T, 30), total: '10.00', outstanding: '0.00' },
  ];
  it('predicts each open invoice and totals by band in decimals', () => {
    const p = predictOpenInvoices(open, history, T);
    expect(p.map((x) => [x.invoiceId, x.band])).toEqual([['a1', 'ON_TIME'], ['b1', 'VERY_LATE'], ['b2', 'LATE']]);
    expect(p[2]!.reasons).toContain('Another invoice to this customer is 35 days overdue');
    const rows = p.map((prediction) => ({ prediction, outstanding: open.find((o) => o.id === prediction.invoiceId)!.outstanding }));
    const s = predictionSummary(rows, T, 2);
    expect(s).toMatchObject({ invoices: 3, outstanding: '10000.50', byBand: { ON_TIME: { invoices: 1, outstanding: '5000.00' }, LATE: { invoices: 1, outstanding: '2000.50' }, VERY_LATE: { invoices: 1, outstanding: '3000.00' } } });
    // a1 arrives around its due date (20 days away); b1 a week from today; b2 well after.
    expect(s.expectedIn30Days).toBe('8000.00');
    expect(p.map((x) => x.lateChance)).toEqual([6, 100, 80]);
    // 6% of 5,000 + all of 3,000 + 80% of 2,000.50.
    expect(s.atRisk).toBe('4900.40');
  });

  it('checks the method against invoices already paid, from what was known then', () => {
    const r = backtestPredictions(history, T);
    expect(r.tested).toBeGreaterThan(0);
    expect(r.meanErrorDays).not.toBeNull();
    expect(r.rightBandShare).toBeGreaterThan(0.5);
    expect(backtestPredictions([], T)).toEqual({ tested: 0, meanErrorDays: null, withinWeekShare: null, rightBandShare: null });
  });
});
