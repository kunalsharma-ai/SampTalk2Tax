import { describe, expect, it } from 'vitest';
import { CAPABILITY_KEYS, COUNTRY_MODULES, countryModule, countrySupports, plannedStarterRates, presetForCountry } from '../src';

describe('country modules', () => {
  it('lists every capability once for each country, with a source and review date', () => {
    for (const m of COUNTRY_MODULES) {
      expect(m.capabilities.map((c) => c.key).sort()).toEqual([...CAPABILITY_KEYS].sort());
      expect(m.sources.length).toBeGreaterThan(0);
      expect(m.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.limitations.length).toBeGreaterThan(0);
      for (const r of m.starterRates) expect(r.rate).toMatch(/^\d+(\.\d+)?$/);
      expect(new Set(m.starterRates.map((r) => r.name)).size).toBe(m.starterRates.length);
    }
    expect(new Set(COUNTRY_MODULES.map((m) => m.code)).size).toBe(COUNTRY_MODULES.length);
  });

  it('says India is full, the others are starter or accounting only', () => {
    expect(countryModule('IN').level).toBe('FULL');
    expect(countryModule('GB').level).toBe('STARTER');
    expect(countryModule('US').level).toBe('ACCOUNTING_ONLY');
    const fr = countryModule('FR');
    expect(fr.level).toBe('ACCOUNTING_ONLY');
    expect(fr.capabilities.filter((c) => c.status !== 'NOT_SUPPORTED').map((c) => c.key)).toEqual(['ACCOUNTING']);
  });

  it('shows India-only pages only in India', () => {
    expect(countrySupports('IN', 'E_INVOICING')).toBe(true);
    expect(countrySupports('IN', 'PAYROLL')).toBe(true);
    for (const c of ['AE', 'GB', 'US', 'FR']) {
      expect(countrySupports(c, 'SALES_TAX_RETURNS')).toBe(false);
      expect(countrySupports(c, 'PAYROLL')).toBe(false);
      expect(countrySupports(c, 'ACCOUNTING')).toBe(true);
    }
  });

  it('agrees with the invoice presets about which countries have a layout', () => {
    for (const m of COUNTRY_MODULES) {
      const own = presetForCountry(m.code).id !== 'GENERIC';
      expect(m.capabilities.find((c) => c.key === 'INVOICE_PRESET')!.status !== 'NOT_SUPPORTED').toBe(own);
    }
  });

  it('plans starter rates, skipping names that exist and unknown choices', () => {
    const all = plannedStarterRates('GB', []);
    expect(all.add.map((r) => r.rate)).toEqual(['20', '5', '0']);
    const some = plannedStarterRates('GB', [' vat 20% (STANDARD) '], ['VAT 20% (standard)', 'VAT 5% (reduced)', 'VAT 99%']);
    expect(some.add.map((r) => r.name)).toEqual(['VAT 5% (reduced)']);
    expect(some.skipped.map((s) => s.name).sort()).toEqual(['VAT 20% (standard)', 'VAT 99%']);
    expect(plannedStarterRates('IN', []).refused).toMatch(/own tax engine/);
    expect(plannedStarterRates('US', []).refused).toMatch(/no starter rates/);
    expect(plannedStarterRates('US', []).add).toEqual([]);
  });
});
