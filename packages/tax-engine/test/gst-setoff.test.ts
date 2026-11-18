import { describe, expect, it } from 'vitest';
import { gstPeriodRange, gstSetOff } from '../src';

const s = (r: ReturnType<typeof gstSetOff>) => ({
  uses: r.uses.map((u) => `${u.from}>${u.against} ${u.amount.toFixed()}`),
  cash: [r.cash.igst, r.cash.cgst, r.cash.sgst].map((x) => x.toFixed()),
  left: [r.creditLeft.igst, r.creditLeft.cgst, r.creditLeft.sgst].map((x) => x.toFixed()),
});

describe('GST set-off', () => {
  it('uses IGST credit first, on IGST and then where CGST and SGST credit fall short', () => {
    const r = gstSetOff({ igst: '1000', cgst: '900', sgst: '900' }, { igst: '1500', cgst: '200', sgst: '900' });
    // IGST 1000 settled; 500 IGST left goes to the CGST shortfall (700): 500; SGST is covered by SGST credit.
    expect(s(r)).toEqual({ uses: ['igst>igst 1000', 'igst>cgst 500', 'cgst>cgst 200', 'sgst>sgst 900'], cash: ['0', '200', '0'], left: ['0', '0', '0'] });
  });
  it('never uses CGST credit against SGST or the other way round; both can pay IGST', () => {
    const r = gstSetOff({ igst: '300', cgst: '0', sgst: '500' }, { igst: '0', cgst: '400', sgst: '100' });
    expect(s(r)).toEqual({ uses: ['cgst>igst 300', 'sgst>sgst 100'], cash: ['0', '0', '400'], left: ['0', '100', '0'] });
  });
  it('must use up IGST credit even where CGST and SGST credit could have paid', () => {
    const r = gstSetOff({ igst: '0', cgst: '100', sgst: '100' }, { igst: '150', cgst: '100', sgst: '100' });
    expect(s(r)).toEqual({ uses: ['igst>cgst 100', 'igst>sgst 50', 'sgst>sgst 50'], cash: ['0', '0', '0'], left: ['0', '100', '50'] });
  });
  it('pays in cash what credit does not cover, and treats negatives as nothing', () => {
    const r = gstSetOff({ igst: '118.50', cgst: '45.25', sgst: '-10' }, { igst: '0', cgst: '5', sgst: '0' });
    expect(s(r)).toEqual({ uses: ['cgst>cgst 5'], cash: ['118.5', '40.25', '0'], left: ['0', '0', '0'] });
    expect(r.creditUsed.cgst.toFixed()).toBe('5');
    expect(r.paidByCredit.cgst.toFixed()).toBe('5');
  });
  it('pays reverse-charge tax in cash even when credit is left', () => {
    const r = gstSetOff({ igst: '0', cgst: '590', sgst: '590' }, { igst: '0', cgst: '1000', sgst: '1000' }, { igst: '0', cgst: '90', sgst: '90' });
    expect(s(r)).toEqual({ uses: ['cgst>cgst 500', 'sgst>sgst 500'], cash: ['0', '90', '90'], left: ['0', '500', '500'] });
    expect(r.reverseCharge.cgst.toFixed()).toBe('90');
  });
  it('works out a month', () => {
    expect(gstPeriodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(gstPeriodRange('2028-02').to).toBe('2028-02-29');
    expect(() => gstPeriodRange('2026-13')).toThrow();
  });
});
