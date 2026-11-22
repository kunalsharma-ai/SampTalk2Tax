import { describe, expect, it } from 'vitest';
import { investigateBillExceptions, type ExceptionBill, type RelatedBill } from '../src/bill-exceptions';
import { matchBill, type MatchBillLine } from '../src/purchase-orders';

const today = '2026-11-20';
const orderLines = [
  { lineNo: 1, description: 'Packing cartons', quantity: '100', unitPrice: '40', received: '60' },
  { lineNo: 2, description: 'Stretch film rolls', quantity: '10', unitPrice: '250', received: '10' },
];
const ol = (n: number, billedElsewhere = '0') => {
  const o = orderLines[n - 1]!;
  return { lineNo: o.lineNo, quantity: o.quantity, unitPrice: o.unitPrice, received: o.received, billedElsewhere };
};
function makeBill(lines: MatchBillLine[], more: Partial<ExceptionBill> = {}, status = 'ISSUED'): ExceptionBill {
  const m = matchBill({ mode: 'THREE_WAY', priceTolerancePercent: '0', quantityTolerancePercent: '0', orderOpen: status === 'ISSUED', lines });
  return {
    id: 'b1',
    number: 'BILL-0009',
    reference: 'KP/902',
    issueDate: '2026-11-15',
    currency: 'INR',
    order: { reference: 'PO-0001', status, orderDate: '2026-10-01', lines: orderLines },
    lines: m.lines.map((l, i) => ({ ...l, description: lines[i]!.description ?? null })),
    ...more,
  };
}
const related = (more: Partial<RelatedBill> & Pick<RelatedBill, 'lines'>): RelatedBill => ({ id: 'r1', number: 'BILL-0003', reference: 'KP/700', issueDate: '2026-10-20', status: 'POSTED', sameOrder: true, ...more });

describe('bill exception investigation', () => {
  it('waits for goods still due, and treats unlinked lines and freight apart', () => {
    const bill = makeBill([
      { lineNo: 1, description: 'Packing cartons', quantity: '30', unitPrice: '40', order: ol(1, '50') },
      { lineNo: 2, description: 'packing CARTONS', quantity: '5', unitPrice: '40', order: null },
      { lineNo: 3, description: 'Freight to Pune', quantity: '1', unitPrice: '500', order: null },
      { lineNo: 4, description: 'Pallets', quantity: '2', unitPrice: '300', order: null },
    ]);
    const r = investigateBillExceptions({ bill, related: [], today, scale: 2 });
    expect(r.findings.map((f) => [f.lineNo, f.cause, f.action])).toEqual([
      [4, 'NOT_ORDERED', 'ASK_CORRECTION'],
      [2, 'LINE_NOT_LINKED', 'LINK_LINE'],
      [1, 'AWAITING_DELIVERY', 'RECORD_RECEIPT'],
      [3, 'EXTRA_CHARGE', 'CONFIRM_CHARGE'],
    ]);
    // 80 billed in all against 60 received: 20 short, and 40 more are still due.
    expect(r.findings.find((f) => f.lineNo === 1)).toMatchObject({ amount: '800.00', explanation: expect.stringContaining('20 of what is billed is not received yet, and 40 more are still due on PO-0001') });
    expect(r.atStake).toBe('2100.00'); // 800 + 200 + 500 + 600
    expect(r.nextAction).toBe('ASK_CORRECTION');
    expect(r.acceptable).toBe(false);
    expect(r.daysHeld).toBe(5);
  });

  it('finds a likely duplicate before over-billing, by order line or vendor invoice number', () => {
    const bill = makeBill([{ lineNo: 1, description: 'Stretch film rolls', quantity: '10', unitPrice: '250', order: ol(2, '10') }]);
    const same = investigateBillExceptions({ bill, related: [related({ lines: [{ orderLineNo: 2, description: 'Stretch film', quantity: '10', unitPrice: '250' }] })], today, scale: 2 });
    expect(same.findings).toHaveLength(1);
    expect(same.findings[0]).toMatchObject({ cause: 'POSSIBLE_DUPLICATE', amount: '2500.00', evidence: [{ id: 'r1', number: 'BILL-0003' }] });
    expect(same.findings[0]!.explanation).toBe('BILL-0003 of 20 Oct 2026 bills the same 10 at ₹250.00 on order line 2; with this bill 20 would be billed against 10 ordered.');
    const byRef = investigateBillExceptions({ bill, related: [related({ reference: 'kp-902', sameOrder: false, lines: [] })], today, scale: 2 });
    expect(byRef.findings[0]!.explanation).toMatch(/same vendor invoice number \(kp-902\)/);
    const voided = investigateBillExceptions({ bill, related: [related({ status: 'VOID', lines: [{ orderLineNo: 2, description: null, quantity: '10', unitPrice: '250' }] })], today, scale: 2 });
    expect(voided.findings[0]).toMatchObject({ cause: 'BILLED_MORE_THAN_ORDERED', amount: '2500.00', action: 'ASK_CREDIT_NOTE' });
  });

  it('reads a higher price as a price rise when the vendor charged it before', () => {
    const bill = makeBill([{ lineNo: 1, description: 'Packing cartons', quantity: '50', unitPrice: '44', order: ol(1) }]);
    const rise = investigateBillExceptions({ bill, related: [related({ sameOrder: false, lines: [{ orderLineNo: null, description: 'PACKING CARTONS', quantity: '20', unitPrice: '43' }] })], today, scale: 2 });
    expect(rise.findings[0]).toMatchObject({ cause: 'VENDOR_PRICE_RISE', amount: '200.00', action: 'CONFIRM_PRICE' });
    expect(rise.findings[0]!.explanation).toContain('(10% more). BILL-0003 of 20 Oct 2026 also charged ₹43.00');
    expect(rise.acceptable).toBe(true);
    // A bill from before the order says nothing about a rise since.
    const before = investigateBillExceptions({ bill, related: [related({ issueDate: '2026-09-01', lines: [{ orderLineNo: null, description: 'Packing cartons', quantity: '1', unitPrice: '45' }] })], today, scale: 2 });
    expect(before.findings[0]).toMatchObject({ cause: 'PRICE_DIFFERENCE', action: 'ASK_CORRECTION' });
  });

  it('cannot wait for goods on a closed order', () => {
    const bill = makeBill([{ lineNo: 1, description: 'Packing cartons', quantity: '10', unitPrice: '40', order: ol(1, '60') }], {}, 'CLOSED');
    const r = investigateBillExceptions({ bill, related: [], today, scale: 2 });
    expect(r.findings.map((f) => f.cause)).toEqual(['BILLED_MORE_THAN_DELIVERED', 'ORDER_NOT_OPEN']);
    expect(r.findings[0]!.explanation).toBe('Line 1: 70 billed in all against 60 received on PO-0001, which is no longer open.');
    expect(r.atStake).toBe('400.00');
  });
});
