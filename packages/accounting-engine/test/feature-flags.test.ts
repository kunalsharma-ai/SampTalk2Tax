import { describe, expect, it } from 'vitest';
import { evaluateFlag, FEATURE_FLAGS, flagBucket, isFlagKey } from '../src';

const def = FEATURE_FLAGS[0];
const ids = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('feature flags', () => {
  it('buckets organisations stably and roughly evenly', () => {
    expect(flagBucket('benchmarking', ids[0]!)).toBe(flagBucket('benchmarking', ids[0]!));
    const share = ids.filter((id) => flagBucket('benchmarking', id) < 25).length / ids.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
  });
  it('keeps an organisation on as the rollout grows', () => {
    const at10 = ids.filter((id) => evaluateFlag(def, { enabled: true, rolloutPercent: 10 }, id, null).on);
    expect(at10.every((id) => evaluateFlag(def, { enabled: true, rolloutPercent: 50 }, id, null).on)).toBe(true);
    expect(ids.every((id) => evaluateFlag(def, { enabled: true, rolloutPercent: 100 }, id, null).on)).toBe(true);
    expect(ids.some((id) => evaluateFlag(def, { enabled: true, rolloutPercent: 0 }, id, null).on)).toBe(false);
  });
  it('lets an organisation’s own setting win, and off means off', () => {
    expect(evaluateFlag(def, null, ids[0]!, null)).toEqual({ on: true, reason: 'DEFAULT' });
    expect(evaluateFlag(def, { enabled: false, rolloutPercent: 100 }, ids[0]!, null)).toEqual({ on: false, reason: 'OFF' });
    expect(evaluateFlag(def, { enabled: false, rolloutPercent: 0 }, ids[0]!, true)).toEqual({ on: true, reason: 'OVERRIDE' });
    expect(evaluateFlag(def, { enabled: true, rolloutPercent: 100 }, ids[0]!, false)).toEqual({ on: false, reason: 'OVERRIDE' });
    expect(() => evaluateFlag(def, { enabled: true, rolloutPercent: 101 }, ids[0]!, null)).toThrow(RangeError);
  });
  it('knows its flags', () => {
    expect(isFlagKey('forecast-lab')).toBe(true);
    expect(isFlagKey('nope')).toBe(false);
  });
});
