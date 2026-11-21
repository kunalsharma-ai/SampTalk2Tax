import { describe, expect, it } from 'vitest';
import { fixtureAmount, seededRandom } from '../src/fixtures';

describe('deterministic fixtures (QA-031)', () => {
  it('gives the same sequence for the same seed, and a different one for another seed', () => {
    const a = seededRandom(20);
    const b = seededRandom(20);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const c = seededRandom(21);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs);
    // Pinned values: a change to the generator would change every seeded fixture, so it shows here.
    expect(xs[0]).toBeCloseTo(0.752611, 6);
  });

  it('draws amounts inside the range, with the scale asked for, the same each run', () => {
    const run = (seed: number) => {
      const next = seededRandom(seed);
      return Array.from({ length: 200 }, () => fixtureAmount(next, '100.00', '99999.99'));
    };
    const amounts = run(7);
    expect(run(7)).toEqual(amounts);
    for (const v of amounts) {
      expect(v).toMatch(/^\d+\.\d{2}$/);
      expect(Number(v)).toBeGreaterThanOrEqual(100);
      expect(Number(v)).toBeLessThanOrEqual(99999.99);
    }
    expect(new Set(amounts).size).toBeGreaterThan(190);
    const next = seededRandom(1);
    expect(fixtureAmount(next, '5', '5', 0)).toBe('5');
    expect(fixtureAmount(next, '0.001', '0.009', 3)).toMatch(/^0\.00[1-9]$/);
  });

  it('refuses ranges it cannot draw from', () => {
    const next = seededRandom(1);
    expect(() => fixtureAmount(next, '10', '5')).toThrow('5 is below 10');
    expect(() => fixtureAmount(next, '1.234', '5')).toThrow('more than 2 decimal places');
    expect(() => fixtureAmount(next, '-1', '5')).toThrow('not a plain amount');
  });
});
