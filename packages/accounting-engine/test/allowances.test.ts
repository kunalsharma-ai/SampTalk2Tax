import { describe, expect, it } from 'vitest';
import { allowanceRateIssues, computeAllowance } from '../src';

describe('allowance rates', () => {
  it('accepts mileage rates below the minor unit, per diem only to the currency', () => {
    expect(allowanceRateIssues({ kind: 'MILEAGE', name: 'Car', rate: '9.50' }, 'INR')).toEqual([]);
    expect(allowanceRateIssues({ kind: 'MILEAGE', name: 'Car', rate: '0.725' }, 'USD')).toEqual([]);
    expect(allowanceRateIssues({ kind: 'MILEAGE', name: 'Car', rate: '0.72512' }, 'USD')).toEqual(['The rate can have at most 4 decimal places']);
    expect(allowanceRateIssues({ kind: 'PER_DIEM', name: 'Metro city', rate: '2500.005' }, 'INR')).toEqual(['A daily rate has at most 2 decimal places in INR']);
    expect(allowanceRateIssues({ kind: 'PER_DIEM', name: 'Tokyo', rate: '8000' }, 'JPY')).toEqual([]);
    expect(allowanceRateIssues({ kind: 'PER_DIEM', name: ' ', rate: '0' }, 'INR')).toHaveLength(2);
    expect(allowanceRateIssues({ kind: 'MILEAGE', name: 'Car', rate: 'abc' }, 'INR')).toEqual(['The rate must be a decimal amount']);
  });
});

describe('mileage', () => {
  it('is distance × rate, rounded half-even to the currency', () => {
    const a = computeAllowance({ kind: 'MILEAGE', rateName: 'Car', rate: '9.50', quantity: '42.5', from: 'Pune', to: 'Lonavala', purpose: 'Client visit' }, 'INR');
    expect(a.amount.toFixed(2)).toBe('403.75');
    expect(a.description).toBe('Mileage 42.5 km × 9.50 (Car), Pune to Lonavala: Client visit');
    // 0.725 × 10.1 = 7.3225 → 7.32; 0.725 × 11 = 7.975 → 7.98 (half-even on the third place is not a tie here)
    expect(computeAllowance({ kind: 'MILEAGE', rateName: 'Car', rate: '0.725', quantity: '10.1', from: 'A', to: 'B' }, 'USD').amount.toFixed()).toBe('7.32');
    // An exact tie rounds to even: 0.45 × 0.5 = 0.225 → 0.22
    expect(computeAllowance({ kind: 'MILEAGE', rateName: 'Car', rate: '0.45', quantity: '0.5', from: 'A', to: 'B' }, 'GBP').amount.toFixed()).toBe('0.22');
  });

  it('refuses distances that are zero, too long, too precise, or without a route', () => {
    const base = { kind: 'MILEAGE' as const, rateName: 'Car', rate: '9.50', from: 'A', to: 'B' };
    expect(() => computeAllowance({ ...base, quantity: '0' }, 'INR')).toThrow(/above 0/);
    expect(() => computeAllowance({ ...base, quantity: '5000.1' }, 'INR')).toThrow(/at most 5000/);
    expect(() => computeAllowance({ ...base, quantity: '12.25' }, 'INR')).toThrow(/one decimal place/);
    expect(() => computeAllowance({ ...base, quantity: '12', to: '' }, 'INR')).toThrow(/started and where it ended/);
    expect(() => computeAllowance({ ...base, quantity: 'ten' }, 'INR')).toThrow(/kilometres/);
  });
});

describe('per diem', () => {
  it('is days × daily rate, whole or half days', () => {
    const a = computeAllowance({ kind: 'PER_DIEM', rateName: 'Metro city', rate: '2500', quantity: '2.5', to: 'Mumbai' }, 'INR');
    expect(a.amount.toFixed(2)).toBe('6250.00');
    expect(a.description).toBe('Per diem 2.5 days × 2500 (Metro city), Mumbai');
    expect(computeAllowance({ kind: 'PER_DIEM', rateName: 'Other', rate: '1200', quantity: '1', to: 'Nashik' }, 'INR').description).toBe('Per diem 1 day × 1200 (Other), Nashik');
  });

  it('refuses quarter days, more than a month, and no place', () => {
    const base = { kind: 'PER_DIEM' as const, rateName: 'Metro', rate: '2500', to: 'Delhi' };
    expect(() => computeAllowance({ ...base, quantity: '1.25' }, 'INR')).toThrow(/whole or half days/);
    expect(() => computeAllowance({ ...base, quantity: '32' }, 'INR')).toThrow(/at most 31/);
    expect(() => computeAllowance({ ...base, quantity: '1', to: ' ' }, 'INR')).toThrow(/where you stayed/);
  });
});
