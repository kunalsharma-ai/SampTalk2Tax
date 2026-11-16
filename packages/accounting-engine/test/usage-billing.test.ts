import { describe, expect, it } from 'vitest';
import { meterPricingIssues, parseUsageCsv, pricingSummary, usageCharge, type MeterPricing } from '../src';

const label = { name: 'API calls', unit: 'calls', period: '1 Nov 2026 to 30 Nov 2026' };
const tiers = [{ upTo: '1000', unitPrice: '2' }, { upTo: '10000', unitPrice: '1.5' }, { upTo: null, unitPrice: '1' }];

describe('usage pricing', () => {
  it('prices per unit after the included allowance', () => {
    const m: MeterPricing = { pricing: 'PER_UNIT', tiers: [{ upTo: null, unitPrice: '0.25' }], included: '1000', minimum: null };
    const c = usageCharge(m, '4200', label);
    expect(c).toMatchObject({ used: '4200', billable: '3200', amount: '800' });
    expect(c.lines).toEqual([{ description: 'API calls, 1 Nov 2026 to 30 Nov 2026: 4,200 calls used, 1,000 included', quantity: '3200', unitPrice: '0.25' }]);
    expect(usageCharge(m, '600', label)).toMatchObject({ billable: '0', amount: '0' });
  });

  it('prices graduated tiers unit by unit across the tiers', () => {
    const c = usageCharge({ pricing: 'GRADUATED', tiers, included: '0', minimum: null }, '12500', label);
    expect(c.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([['1000', '2'], ['9000', '1.5'], ['2500', '1']]);
    expect(c.amount).toBe('18000');
    expect(c.lines[1]!.description).toBe('API calls: over 1,000 to 10,000 calls');
    expect(usageCharge({ pricing: 'GRADUATED', tiers, included: '0', minimum: null }, '800', label).lines).toHaveLength(1);
  });

  it('prices volume tiers by the tier the whole quantity falls in, with a minimum', () => {
    const v = usageCharge({ pricing: 'VOLUME', tiers, included: '0', minimum: null }, '12500', label);
    expect(v.lines).toEqual([{ description: expect.stringContaining('(tier 3)'), quantity: '12500', unitPrice: '1' }]);
    expect(usageCharge({ pricing: 'VOLUME', tiers, included: '0', minimum: null }, '1000', label).lines[0]!.unitPrice).toBe('2');
    const low = usageCharge({ pricing: 'VOLUME', tiers, included: '0', minimum: '5000' }, '300', label);
    expect(low.amount).toBe('5000');
    expect(low.lines[1]).toEqual({ description: 'API calls: minimum charge of 5,000 for the period', quantity: '1', unitPrice: '4400' });
  });

  it('refuses pricing that cannot be billed and summarises good pricing', () => {
    expect(meterPricingIssues({ pricing: 'GRADUATED', tiers: [{ upTo: '100', unitPrice: '1' }, { upTo: '50', unitPrice: '1' }, { upTo: null, unitPrice: '-1' }], included: '-1', minimum: null })).toEqual([
      'The included quantity must be zero or more',
      'Tier 2: the upper limit must be more than 100',
      'Tier 3: the unit price must be zero or more',
    ]);
    expect(meterPricingIssues({ pricing: 'PER_UNIT', tiers: [{ upTo: '5', unitPrice: '1' }], included: '0', minimum: null })).toEqual(['The last tier has no upper limit']);
    expect(pricingSummary({ pricing: 'GRADUATED', tiers, included: '500', minimum: '100' }, 'call')).toBe('Graduated tiers (to 1,000 2, to 10,000 1.5, then 1) per call after 500 included, at least 100 a period');
  });

  it('reads usage from CSV with errors by line', () => {
    const r = parseUsageCsv('Date,Meter,Quantity,Reference\n2026-11-03,api_calls,"1,200",batch-1\n2026-11-04,api calls,5,\n2026-13-01,api_calls,5,\n2026-11-05,storage_gb,x,\n');
    expect(r.rows).toEqual([{ meter: 'api_calls', date: '2026-11-03', quantity: '1200', reference: 'batch-1' }]);
    expect(r.errors).toEqual(['Line 3: "api calls" is not a meter code', 'Line 4: the date must be YYYY-MM-DD', 'Line 5: "x" is not a quantity']);
    expect(parseUsageCsv('a,b\n1,2').errors[0]).toMatch(/meter, date and quantity/);
  });
});
