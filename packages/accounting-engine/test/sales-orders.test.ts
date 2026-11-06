import { describe, expect, it } from 'vitest';
import { billingIssues, orderBilling, quoteAllows, quoteState, remainingToBill, SalesOrderError } from '../src';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as SalesOrderError).code;
  }
  return null;
};
const T = '2026-11-06';

describe('quotations', () => {
  it('expire once sent and past their date', () => {
    expect(quoteState('SENT', '2026-11-05', T)).toBe('EXPIRED');
    expect(quoteState('SENT', T, T)).toBe('SENT');
    expect(quoteState('DRAFT', '2026-01-01', T)).toBe('DRAFT');
    expect(quoteState('ACCEPTED', '2026-01-01', T)).toBe('ACCEPTED');
  });
  it('allow each step only in the right state', () => {
    expect(code(() => quoteAllows('DRAFT', T, T, 'EDIT'))).toBeNull();
    expect(code(() => quoteAllows('SENT', T, T, 'EDIT'))).toBe('QUOTE_NOT_DRAFT');
    expect(code(() => quoteAllows('DRAFT', '2026-11-01', T, 'SEND'))).toBe('QUOTE_EXPIRED');
    expect(code(() => quoteAllows('DRAFT', T, T, 'ACCEPT'))).toBe('QUOTE_NOT_SENT');
    expect(code(() => quoteAllows('SENT', T, T, 'ACCEPT'))).toBeNull();
    expect(code(() => quoteAllows('SENT', '2026-11-01', T, 'ACCEPT'))).toBe('QUOTE_EXPIRED');
    expect(code(() => quoteAllows('SENT', '2026-11-01', T, 'DECLINE'))).toBeNull();
    expect(code(() => quoteAllows('ACCEPTED', T, T, 'DECLINE'))).toBe('QUOTE_NOT_SENT');
    expect(code(() => quoteAllows('SENT', '2026-11-01', T, 'REVISE'))).toBeNull();
    expect(code(() => quoteAllows('DECLINED', T, T, 'REVISE'))).toBeNull();
    expect(code(() => quoteAllows('ACCEPTED', T, T, 'REVISE'))).toBe('QUOTE_NOT_REVISABLE');
    expect(code(() => quoteAllows('DRAFT', T, T, 'REVISE'))).toBe('QUOTE_NOT_REVISABLE');
  });
});

describe('order billing', () => {
  const lines = [
    { id: 'a', lineNo: 1, quantity: '10', billed: '4' },
    { id: 'b', lineNo: 2, quantity: '1', billed: '0' },
  ];
  it('tracks what is left and the order state', () => {
    expect(remainingToBill(lines[0]!)).toBe('6');
    expect(remainingToBill({ quantity: '1', billed: '2' })).toBe('0');
    expect(orderBilling([{ quantity: '1', billed: '0' }])).toBe('NOT_BILLED');
    expect(orderBilling(lines)).toBe('PARTLY_BILLED');
    expect(orderBilling([{ quantity: '2.5', billed: '2.5' }, { quantity: '1', billed: '1' }])).toBe('BILLED');
  });
  it('refuses billing more than is left, nothing, or a line twice', () => {
    expect(billingIssues(lines, [{ orderLineId: 'a', quantity: '6' }, { orderLineId: 'b', quantity: '1' }])).toEqual([]);
    expect(billingIssues(lines, [{ orderLineId: 'a', quantity: '6.5' }])).toEqual(['Line 1: only 6 left to bill']);
    expect(billingIssues(lines, [{ orderLineId: 'a', quantity: '0' }])).toEqual(['Line 1: bill a quantity above 0']);
    expect(billingIssues(lines, [{ orderLineId: 'b', quantity: '1' }, { orderLineId: 'b', quantity: '1' }])).toContain('Line 2 is listed twice');
    expect(billingIssues(lines, [])).toEqual(['Choose at least one line to bill']);
    expect(billingIssues(lines, [{ orderLineId: 'z', quantity: '1' }])).toEqual(['A line to bill is not on this order']);
  });
});
