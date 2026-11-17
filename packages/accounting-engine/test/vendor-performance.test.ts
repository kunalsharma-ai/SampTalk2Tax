import { describe, expect, it } from 'vitest';
import { deliveredOn, gradeFor, orderDelivery, reviewIssues, vendorScorecard, type PerfOrder } from '../src/vendor-performance';
import { D } from '../src/money';

const order = (over: Partial<PerfOrder> = {}): PerfOrder => ({
  id: 'o1',
  ref: 'PO-0001',
  orderDate: '2026-10-01',
  expectedDate: '2026-10-10',
  status: 'ISSUED',
  lines: [{ id: 'l1', quantity: '10', unitPrice: '100' }, { id: 'l2', quantity: '5', unitPrice: '200' }],
  receipts: [],
  ...over,
});

describe('vendor performance', () => {
  it('finds the day an order was fully delivered', () => {
    const o = order({ receipts: [
      { orderLineId: 'l1', date: '2026-10-05', quantity: '10', rejected: '0' },
      { orderLineId: 'l2', date: '2026-10-08', quantity: '3', rejected: '2' },
      { orderLineId: 'l2', date: '2026-10-12', quantity: '2', rejected: '0' },
    ] });
    expect(deliveredOn(o)).toBe('2026-10-12');
    expect(orderDelivery(o, '2026-11-01')).toMatchObject({ outcome: 'LATE', daysLate: 2 });
    expect(orderDelivery(order({ receipts: [{ orderLineId: 'l1', date: '2026-10-10', quantity: '10', rejected: '0' }, { orderLineId: 'l2', date: '2026-10-09', quantity: '5', rejected: '0' }] }), '2026-11-01')).toMatchObject({ outcome: 'ON_TIME', daysLate: 0 });
  });

  it('counts an order still short after its date as overdue, and leaves out ones not yet due or without a date', () => {
    expect(orderDelivery(order(), '2026-10-15')).toMatchObject({ outcome: 'OVERDUE', daysLate: 5, deliveredOn: null });
    expect(orderDelivery(order(), '2026-10-10')).toBeNull();
    expect(orderDelivery(order({ expectedDate: null }), '2026-12-01')).toBeNull();
    expect(orderDelivery(order({ status: 'CANCELLED' }), '2026-12-01')).toBeNull();
    // Closed short: judged on its last delivery.
    expect(orderDelivery(order({ status: 'CLOSED', receipts: [{ orderLineId: 'l1', date: '2026-10-09', quantity: '8', rejected: '0' }] }), '2026-12-01')).toMatchObject({ outcome: 'ON_TIME' });
  });

  it('scores delivery, quality by value, billing accuracy and reviews, and reports price overcharges', () => {
    const late = order({ receipts: [
      { orderLineId: 'l1', date: '2026-10-05', quantity: '9', rejected: '1' },
      { orderLineId: 'l1', date: '2026-10-12', quantity: '1', rejected: '0' },
      { orderLineId: 'l2', date: '2026-10-05', quantity: '5', rejected: '0' },
    ] });
    const ok = order({ id: 'o2', ref: 'PO-0002', lines: [{ id: 'm1', quantity: '4', unitPrice: '250' }], receipts: [{ orderLineId: 'm1', date: '2026-10-03', quantity: '4', rejected: '0' }] });
    const s = vendorScorecard({
      orders: [late, ok],
      bills: [
        { id: 'b1', issueDate: '2026-10-12', subtotal: '2050', linkedToOrder: true, differencesAccepted: true },
        { id: 'b2', issueDate: '2026-10-04', subtotal: '1000', linkedToOrder: true, differencesAccepted: false },
        { id: 'b3', issueDate: '2026-10-20', subtotal: '300', linkedToOrder: false, differencesAccepted: false },
      ],
      billLines: [
        { documentId: 'b1', orderLineId: 'l1', quantity: '10', unitPrice: '105' },
        { documentId: 'b1', orderLineId: 'l2', quantity: '5', unitPrice: '200' },
        { documentId: 'b2', orderLineId: 'm1', quantity: '4', unitPrice: '250' },
      ],
      vendorCredits: [{ subtotal: '100' }],
      reviews: [{ rating: 4 }, { rating: 5 }],
      today: '2026-11-01',
    });
    expect(s.delivery).toMatchObject({ measured: 2, onTime: 1, late: 1, onTimePercent: '50.0', averageDaysLate: '2.0' });
    // Received 1,000 + 1,000 + 1,000 = 3,000 at order prices plus 100 rejected; 100 / 3,100.
    expect(s.quality).toMatchObject({ receivedValue: '3100.00', rejectedValue: '100.00', rejectedPercent: '3.23' });
    expect(s.price).toMatchObject({ billedLines: 3, linesAbovePrice: 1, overcharge: '50.00', variancePercent: '1.67' });
    expect(s.billing).toMatchObject({ bills: 3, spend: '3350.00', linkedBills: 2, withAcceptedDifferences: 1, accuracyPercent: '50.0', vendorCredits: 1, vendorCreditValue: '100.00' });
    expect(s.reviews).toEqual({ count: 2, average: '4.5' });
    // 50×40 + (100 − 32.26)×30 + 50×20 + 87.5×10, over 100.
    expect(s.parts.map((p) => [p.key, p.score])).toEqual([['DELIVERY', '50.0'], ['QUALITY', '67.7'], ['BILLING', '50.0'], ['REVIEWS', '87.5']]);
    expect(s.score).toBe('59.1');
    expect(s.grade).toBe('D');
  });

  it('reweights over what can be measured, and has no score with nothing to go on', () => {
    const only = vendorScorecard({ orders: [], bills: [], billLines: [], vendorCredits: [], reviews: [{ rating: 5 }], today: '2026-11-01' });
    expect(only).toMatchObject({ score: '100.0', grade: 'A' });
    const none = vendorScorecard({ orders: [], bills: [], billLines: [], vendorCredits: [], reviews: [], today: '2026-11-01' });
    expect(none).toMatchObject({ score: null, grade: null, parts: [] });
    expect([90, 89.9, 75, 60, 59.9].map((x) => gradeFor(new D(x)))).toEqual(['A', 'B', 'B', 'C', 'D']);
  });

  it('checks a review', () => {
    expect(reviewIssues({ rating: 4, aspect: 'Delivery', note: null })).toEqual([]);
    expect(reviewIssues({ rating: 6, aspect: 'Delivery', note: null })).toEqual(['A rating is a whole number from 1 to 5']);
    expect(reviewIssues({ rating: 2, aspect: 'Taste', note: ' ' })).toHaveLength(2);
  });
});
