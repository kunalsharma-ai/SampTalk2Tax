import { describe, expect, it } from 'vitest';
import { checkGstin, gstinCheckCharacter, INDIA_STATES, indiaState, isPlaceOfSupply, placeOfSupplyName } from '../src';

describe('GSTIN', () => {
  it('accepts GSTINs whose check character is right', () => {
    // The sample GSTIN from GSTN's published documentation, and synthetic ones built from made-up PANs.
    const synthetic = ['29ZZZCZ0001Z1Z', '07ZZZPZ9999Z2Z', '33ZZZFZ0042ZAZ'].map((x) => x + gstinCheckCharacter(x));
    for (const g of ['27AAPFU0939F1ZV', ...synthetic]) {
      const r = checkGstin(g);
      expect(r.issues).toEqual([]);
      expect(r.valid).toBe(true);
    }
    expect(checkGstin(' 27aapfu0939f1zv ')).toMatchObject({ valid: true, gstin: '27AAPFU0939F1ZV', stateCode: '27', pan: 'AAPFU0939F' });
  });

  it('computes the check character', () => {
    expect(gstinCheckCharacter('27AAPFU0939F1Z')).toBe('V');
    expect(() => gstinCheckCharacter('27aapfu')).toThrow();
  });

  it('rejects a single typing mistake', () => {
    const r = checkGstin('27AAPFU0939F1ZW');
    expect(r.valid).toBe(false);
    expect(r.issues[0]).toMatch(/check character/);
    expect(checkGstin('27AAPFU0938F1ZV').valid).toBe(false);
  });

  it('rejects wrong length, shape and unknown state codes', () => {
    expect(checkGstin('27AAPFU0939F1Z').issues[0]).toMatch(/15 characters/);
    expect(checkGstin('27AAPF00939F1ZV').issues[0]).toMatch(/PAN/);
    const bad = '99AAPFU0939F1Z';
    expect(checkGstin(bad + gstinCheckCharacter(bad)).issues).toEqual(['99 is not a GST state code']);
    const retired = '28AAPFU0939F1Z';
    expect(checkGstin(retired + gstinCheckCharacter(retired)).valid).toBe(false);
  });
});

describe('states', () => {
  it('lists each code once and marks UTs without a legislature as UTGST', () => {
    expect(new Set(INDIA_STATES.map((s) => s.code)).size).toBe(INDIA_STATES.length);
    expect(indiaState('04')?.levies).toBe('UTGST');
    expect(indiaState('07')?.levies).toBe('SGST');
    expect(indiaState('38')?.levies).toBe('UTGST');
  });
  it('knows export as a place of supply', () => {
    expect(isPlaceOfSupply('96')).toBe(true);
    expect(isPlaceOfSupply('25')).toBe(false);
    expect(placeOfSupplyName('96')).toMatch(/export/);
    expect(placeOfSupplyName('29')).toBe('Karnataka');
  });
});
