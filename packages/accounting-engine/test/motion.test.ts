import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, MOTION_PREFERENCE_CODES, motionReduced } from '../src/locale';

describe('motion preference', () => {
  it('follows the device unless the person chose otherwise', () => {
    expect(DEFAULT_PREFERENCES.motion).toBe('SYSTEM');
    expect(MOTION_PREFERENCE_CODES).toEqual(['SYSTEM', 'FULL', 'REDUCED']);
    expect([motionReduced('SYSTEM', true), motionReduced('SYSTEM', false), motionReduced(null, true), motionReduced(undefined, false)]).toEqual([true, false, true, false]);
    expect([motionReduced('FULL', true), motionReduced('FULL', false)]).toEqual([false, false]);
    expect([motionReduced('REDUCED', true), motionReduced('REDUCED', false)]).toEqual([true, true]);
  });
});
