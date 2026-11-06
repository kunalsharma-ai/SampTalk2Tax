import { describe, expect, it } from 'vitest';
import { checkoutPlan, dunningStage, indianFinancialYear, subscriptionTax, taxInvoiceNumber, toMinorUnits } from '../src';

const d = (s: string) => new Date(s);
const base = { planCode: 'GROWTH', interval: 'MONTHLY' as const, price: '1499', trialEndsAt: null, currency: 'INR' as const };

describe('checkoutPlan', () => {
  it('starts a paid period after the trial, keeping the trial days', () => {
    const p = checkoutPlan({ ...base, status: 'TRIALING', price: null, interval: null, trialEndsAt: d('2026-11-20T00:00:00Z'), currentPeriodStart: null, currentPeriodEnd: null, target: { planCode: 'GROWTH', interval: 'MONTHLY', price: '1499' }, now: d('2026-11-10T00:00:00Z') });
    expect(p).toMatchObject({ kind: 'NEW', periodStart: d('2026-11-20T00:00:00Z'), periodEnd: d('2026-12-20T00:00:00Z') });
    if (p.kind !== 'SCHEDULED') expect(p.amount.toFixed(2)).toBe('1499.00');
  });
  it('starts now after a trial has ended or a subscription lapsed', () => {
    const now = d('2026-12-01T00:00:00Z');
    expect(checkoutPlan({ ...base, status: 'TRIALING', price: null, interval: null, trialEndsAt: d('2026-11-20T00:00:00Z'), currentPeriodStart: null, currentPeriodEnd: null, target: { planCode: 'STARTER', interval: 'ANNUAL', price: '4990' }, now })).toMatchObject({ kind: 'NEW', periodStart: now, periodEnd: d('2027-12-01T00:00:00Z') });
    expect(checkoutPlan({ ...base, status: 'ACTIVE', currentPeriodStart: d('2026-10-01T00:00:00Z'), currentPeriodEnd: d('2026-11-01T00:00:00Z'), target: { planCode: 'GROWTH', interval: 'MONTHLY', price: '1499' }, now: d('2026-11-09T00:00:00Z') }).kind).toBe('NEW');
  });
  it('renews the same plan straight after the current period, also in grace', () => {
    const p = checkoutPlan({ ...base, status: 'ACTIVE', currentPeriodStart: d('2026-10-31T00:00:00Z'), currentPeriodEnd: d('2026-11-30T00:00:00Z'), target: { planCode: 'GROWTH', interval: 'MONTHLY', price: '1499' }, now: d('2026-12-03T00:00:00Z') });
    expect(p).toMatchObject({ kind: 'RENEWAL', periodStart: d('2026-11-30T00:00:00Z'), periodEnd: d('2026-12-30T00:00:00Z') });
  });
  it('charges an upgrade for the days left and keeps the period end', () => {
    const p = checkoutPlan({ ...base, status: 'ACTIVE', currentPeriodStart: d('2026-11-01T00:00:00Z'), currentPeriodEnd: d('2026-12-01T00:00:00Z'), target: { planCode: 'PROFESSIONAL', interval: 'MONTHLY', price: '3499' }, now: d('2026-11-16T00:00:00Z') });
    expect(p).toMatchObject({ kind: 'UPGRADE', periodEnd: d('2026-12-01T00:00:00Z') });
    if (p.kind !== 'SCHEDULED') expect(p.amount.toFixed(2)).toBe('1000.00');
  });
  it('schedules a cheaper plan or another billing interval for the renewal', () => {
    const at = { ...base, status: 'ACTIVE' as const, currentPeriodStart: d('2026-11-01T00:00:00Z'), currentPeriodEnd: d('2026-12-01T00:00:00Z'), now: d('2026-11-16T00:00:00Z') };
    expect(checkoutPlan({ ...at, target: { planCode: 'STARTER', interval: 'MONTHLY', price: '499' } }).kind).toBe('SCHEDULED');
    expect(checkoutPlan({ ...at, target: { planCode: 'GROWTH', interval: 'ANNUAL', price: '14990' } }).kind).toBe('SCHEDULED');
  });
  it('never charges a complimentary organisation', () => {
    expect(() => checkoutPlan({ ...base, status: 'COMPLIMENTARY', price: null, currentPeriodStart: null, currentPeriodEnd: null, target: { planCode: 'GROWTH', interval: 'MONTHLY', price: '1499' }, now: new Date() })).toThrow(/complimentary/);
  });
});

describe('subscriptionTax', () => {
  const seller = { countryCode: 'IN', gstin: '27AAAAA0000A1Z5', stateCode: '27' };
  it('charges CGST and SGST in the same state, IGST in another', () => {
    expect(subscriptionTax({ seller, buyer: { countryCode: 'IN', stateCode: '27' }, subtotal: '1499', currency: 'INR' })).toMatchObject({ lines: [{ code: 'CGST', rate: '9', amount: '134.91' }, { code: 'SGST', rate: '9', amount: '134.91' }], taxTotal: '269.82', total: '1768.82' });
    expect(subscriptionTax({ seller, buyer: { countryCode: 'IN', stateCode: '29' }, subtotal: '1499', currency: 'INR' })).toMatchObject({ lines: [{ code: 'IGST', rate: '18', amount: '269.82' }], total: '1768.82', placeOfSupply: 'State code 29' });
    expect(subscriptionTax({ seller, buyer: { countryCode: 'IN' }, subtotal: '499', currency: 'INR' }).lines.map((l) => l.code)).toEqual(['CGST', 'SGST']);
  });
  it('charges no tax on an export, or from an unregistered or foreign supplier', () => {
    expect(subscriptionTax({ seller, buyer: { countryCode: 'GB' }, subtotal: '59', currency: 'USD' })).toMatchObject({ lines: [], total: '59.00', placeOfSupply: 'Outside India' });
    expect(subscriptionTax({ seller: { countryCode: 'IN' }, buyer: { countryCode: 'IN' }, subtotal: '499', currency: 'INR' }).note).toMatch(/not registered/);
    expect(subscriptionTax({ seller: { countryCode: 'GB' }, buyer: { countryCode: 'IN' }, subtotal: '9', currency: 'USD' }).taxTotal).toBe('0.00');
  });
});

describe('numbers and amounts', () => {
  it('numbers tax invoices by Indian financial year in at most 16 characters', () => {
    expect(indianFinancialYear(d('2027-03-31T18:00:00Z')).label).toBe('26-27');
    expect(indianFinancialYear(d('2027-03-31T18:31:00Z')).label).toBe('27-28');
    expect(taxInvoiceNumber('T2T', '26-27', 42)).toBe('T2T/26-27/00042');
    expect(() => taxInvoiceNumber('TOOLONG', '26-27', 1)).toThrow();
  });
  it('turns amounts into paise and cents exactly', () => {
    expect(toMinorUnits('1768.82', 'INR')).toBe(176882);
    expect(toMinorUnits('59', 'USD')).toBe(5900);
    expect(() => toMinorUnits('1.234', 'USD')).toThrow();
  });
  it('steps through reminders: upcoming, due, final, lapsed', () => {
    const end = d('2026-12-01T00:00:00Z');
    expect(dunningStage(end, d('2026-11-20T00:00:00Z'))).toBeNull();
    expect(dunningStage(end, d('2026-11-25T00:00:00Z'))).toBe('UPCOMING');
    expect(dunningStage(end, d('2026-12-02T00:00:00Z'))).toBe('DUE');
    expect(dunningStage(end, d('2026-12-06T12:00:00Z'))).toBe('FINAL');
    expect(dunningStage(end, d('2026-12-08T00:00:00Z'))).toBe('LAPSED');
  });
});
