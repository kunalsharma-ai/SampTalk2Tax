import { describe, expect, it } from 'vitest';
import { goodsReceiptRef, matchBill, purchaseOrderAllows, purchaseOrderRef, purchaseOrderState, quantityToBill, quantityToReceive, receiptIssues, toleranceIssues, withTolerance } from '../src';

describe('purchase order state', () => {
  it('follows receipts and bills', () => {
    expect(purchaseOrderRef(7)).toBe('PO-0007');
    expect(goodsReceiptRef(12)).toBe('GRN-0012');
    const l = (quantity: string, received: string, billed: string) => ({ quantity, received, billed });
    expect(purchaseOrderState('DRAFT', 'THREE_WAY', [l('10', '0', '0')])).toBe('DRAFT');
    expect(purchaseOrderState('ISSUED', 'THREE_WAY', [l('10', '0', '0')])).toBe('ISSUED');
    expect(purchaseOrderState('ISSUED', 'THREE_WAY', [l('10', '4', '0'), l('5', '0', '0')])).toBe('PARTLY_RECEIVED');
    expect(purchaseOrderState('ISSUED', 'THREE_WAY', [l('10', '10', '4'), l('5', '6', '0')])).toBe('RECEIVED');
    expect(purchaseOrderState('ISSUED', 'THREE_WAY', [l('10', '10', '10'), l('5', '5', '5')])).toBe('BILLED');
    expect(purchaseOrderState('ISSUED', 'TWO_WAY', [l('10', '3', '0')])).toBe('ISSUED');
    expect(purchaseOrderState('CLOSED', 'THREE_WAY', [l('10', '3', '0')])).toBe('CLOSED');
  });

  it('allows actions by state', () => {
    expect(() => purchaseOrderAllows('DRAFT', 'EDIT')).not.toThrow();
    expect(() => purchaseOrderAllows('ISSUED', 'EDIT')).toThrow(/can no longer change/);
    expect(() => purchaseOrderAllows('DRAFT', 'RECEIVE')).toThrow(/issue it to the vendor first/);
    expect(() => purchaseOrderAllows('BILLED', 'RECEIVE')).not.toThrow();
    expect(() => purchaseOrderAllows('BILLED', 'BILL')).toThrow(/Everything on this order is billed/);
    expect(() => purchaseOrderAllows('PARTLY_RECEIVED', 'CANCEL')).toThrow(/close it instead/);
    expect(() => purchaseOrderAllows('ISSUED', 'CANCEL')).not.toThrow();
    expect(() => purchaseOrderAllows('CLOSED', 'RECEIVE')).toThrow(/closed/);
  });

  it('works out what is left to receive and bill', () => {
    expect(quantityToBill('THREE_WAY', { quantity: '10', received: '6', billed: '2' })).toBe('4');
    expect(quantityToBill('TWO_WAY', { quantity: '10', received: '0', billed: '2' })).toBe('8');
    expect(quantityToBill('THREE_WAY', { quantity: '10', received: '2', billed: '5' })).toBe('0');
    expect(quantityToReceive({ quantity: '10', received: '12', billed: '0' })).toBe('0');
    expect(withTolerance('100', '2.5').toFixed()).toBe('102.5');
  });
});

describe('goods receipts', () => {
  const lines = [
    { id: 'a', lineNo: 1, quantity: '10', received: '6' },
    { id: 'b', lineNo: 2, quantity: '4', received: '0' },
  ];
  it('refuses more than ordered beyond the tolerance', () => {
    expect(receiptIssues(lines, [{ orderLineId: 'a', quantity: '4' }], '0')).toEqual([]);
    expect(receiptIssues(lines, [{ orderLineId: 'a', quantity: '5' }], '0')).toEqual(['Line 1: only 4 more can be received (ordered 10, received 6)']);
    expect(receiptIssues(lines, [{ orderLineId: 'a', quantity: '5' }], '10')).toEqual([]);
    expect(receiptIssues(lines, [{ orderLineId: 'b', quantity: '0', rejected: '1' }], '0')).toEqual([]);
    expect(receiptIssues(lines, [{ orderLineId: 'b', quantity: '0' }], '0')).toEqual(['Line 2: enter the quantity accepted or rejected']);
    expect(receiptIssues(lines, [{ orderLineId: 'z', quantity: '1' }], '0')).toEqual(['A received line is not on this purchase order']);
    expect(receiptIssues(lines, [], '0')).toEqual(['Enter the quantity received on at least one line']);
  });
  it('checks tolerances', () => {
    expect(toleranceIssues({ priceTolerancePercent: '2', quantityTolerancePercent: '0' })).toEqual([]);
    expect(toleranceIssues({ priceTolerancePercent: '101', quantityTolerancePercent: '1.234' })).toHaveLength(2);
  });
});

describe('bill matching', () => {
  const order = (over: Partial<{ quantity: string; unitPrice: string; received: string; billedElsewhere: string }> = {}) => ({ lineNo: 1, quantity: '10', unitPrice: '100', received: '10', billedElsewhere: '0', ...over });
  const base = { mode: 'THREE_WAY' as const, priceTolerancePercent: '0', quantityTolerancePercent: '0', orderOpen: true };

  it('matches a bill that agrees with the order and the receipts', () => {
    const r = matchBill({ ...base, lines: [{ lineNo: 1, quantity: '10', unitPrice: '100', order: order() }] });
    expect(r.status).toBe('MATCHED');
    expect(r.fingerprint).toBe('');
    expect(matchBill({ ...base, lines: [{ lineNo: 1, quantity: '10', unitPrice: '95', order: order() }] }).status).toBe('MATCHED');
  });

  it('flags price, quantity and receipt differences', () => {
    const r = matchBill({ ...base, lines: [{ lineNo: 1, quantity: '12', unitPrice: '101', order: order({ received: '8' }) }] });
    expect(r.status).toBe('EXCEPTION');
    expect(r.lines[0]!.exceptions.map((e) => e.code)).toEqual(['PRICE_ABOVE_ORDER', 'MORE_THAN_ORDERED', 'MORE_THAN_RECEIVED']);
    expect(r.fingerprint).toContain('Line 1: price 101 is above the order price 100');
  });

  it('leaves out the receipt check for two-way matching', () => {
    const r = matchBill({ ...base, mode: 'TWO_WAY', lines: [{ lineNo: 1, quantity: '10', unitPrice: '100', order: order({ received: '0' }) }] });
    expect(r.status).toBe('MATCHED');
  });

  it('applies the tolerances', () => {
    const r = matchBill({ ...base, priceTolerancePercent: '2', quantityTolerancePercent: '5', lines: [{ lineNo: 1, quantity: '10.5', unitPrice: '102', order: order() }] });
    expect(r.status).toBe('MATCHED');
  });

  it('adds up lines billing one order line, with earlier bills', () => {
    const r = matchBill({ ...base, lines: [
      { lineNo: 1, quantity: '4', unitPrice: '100', order: order({ billedElsewhere: '5' }) },
      { lineNo: 2, quantity: '2', unitPrice: '100', order: order({ billedElsewhere: '5' }) },
    ] });
    expect(r.lines[0]!.status).toBe('MATCHED');
    expect(r.lines[1]!.exceptions[0]!.message).toBe('Line 2: billing 11 in all against 10 ordered');
  });

  it('flags lines not on the order and a closed order', () => {
    const r = matchBill({ ...base, orderOpen: false, lines: [{ lineNo: 1, quantity: '1', unitPrice: '100', order: order() }, { lineNo: 2, quantity: '1', unitPrice: '500', description: 'Freight', order: null }] });
    expect(r.lines.map((l) => l.exceptions.map((e) => e.code))).toEqual([['ORDER_NOT_OPEN'], ['NOT_ON_ORDER']]);
  });
});
