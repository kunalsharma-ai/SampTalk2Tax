import { describe, expect, it } from 'vitest';
import { drawSample, populationFingerprint, sampleProgress, sampleRandom } from '../src';

const pop = Array.from({ length: 50 }, (_, i) => ({ id: `j${String(i).padStart(3, '0')}`, amount: String((i + 1) * 100) }));

describe('audit sampling (AUDIT-009)', () => {
  it('gives the same numbers from the same seed', () => {
    const a = sampleRandom('s1');
    const b = sampleRandom('s1');
    const c = sampleRandom('s2');
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  it('draws a random sample of distinct items that repeats from its seed whatever the input order', () => {
    const s = drawSample(pop, 'RANDOM', 10, 'seed-1');
    expect(s.items).toHaveLength(10);
    expect(new Set(s.items.map((i) => i.id)).size).toBe(10);
    expect(s.items.every((i) => i.reason === 'RANDOM')).toBe(true);
    expect(drawSample([...pop].reverse(), 'RANDOM', 10, 'seed-1').items.map((i) => i.id)).toEqual(s.items.map((i) => i.id));
    expect(drawSample(pop, 'RANDOM', 10, 'seed-2').items.map((i) => i.id)).not.toEqual(s.items.map((i) => i.id));
    expect(drawSample(pop.slice(0, 3), 'RANDOM', 10, 'x').items).toHaveLength(3);
  });

  it('picks by money in monetary unit sampling, always taking items larger than the interval', () => {
    const big = [...pop, { id: 'zbig', amount: '-200000' }];
    const s = drawSample(big, 'MONETARY_UNIT', 10, 'seed-1');
    // total 127500 + 200000 = 327500, interval 32750
    expect(s.interval).toBe('32750.00');
    const zb = s.items.find((i) => i.id === 'zbig');
    expect(zb?.reason).toBe('ABOVE_INTERVAL');
    expect(s.items.length).toBeLessThanOrEqual(10);
    expect(new Set(s.items.map((i) => i.id)).size).toBe(s.items.length);
    expect(drawSample(big, 'MONETARY_UNIT', 10, 'seed-1')).toEqual(s);
    expect(drawSample([{ id: 'a', amount: '0' }], 'MONETARY_UNIT', 5, 'x')).toEqual({ items: [], interval: null });
  });

  it('takes every high-value item first, then a random sample of the rest', () => {
    const s = drawSample(pop, 'HIGH_VALUE', 8, 'seed-1', '4600');
    expect(s.items.slice(0, 5).map((i) => i.id)).toEqual(['j049', 'j048', 'j047', 'j046', 'j045']);
    expect(s.items.slice(0, 5).every((i) => i.reason === 'HIGH_VALUE')).toBe(true);
    expect(s.items.slice(5).every((i) => i.reason === 'RANDOM' && Number(i.amount) < 4600)).toBe(true);
    expect(s.items).toHaveLength(8);
    expect(drawSample(pop, 'HIGH_VALUE', 3, 'seed-1', '4600').items).toHaveLength(5);
    expect(() => drawSample(pop, 'HIGH_VALUE', 3, 'seed-1')).toThrow(/threshold/);
    expect(() => drawSample(pop, 'RANDOM', 0, 'x')).toThrow(/1 to 200/);
    expect(() => drawSample(pop, 'RANDOM', 201, 'x')).toThrow(/1 to 200/);
  });

  it('fingerprints a population so a change shows, and tracks testing progress', () => {
    const f = populationFingerprint(pop);
    expect(populationFingerprint([...pop].reverse())).toBe(f);
    expect(populationFingerprint([...pop.slice(1), { id: 'j000', amount: '100.00' }])).toBe(f);
    expect(populationFingerprint([...pop.slice(1), { id: 'j000', amount: '101' }])).not.toBe(f);
    expect(f.startsWith('50-')).toBe(true);
    expect(sampleProgress([{ result: 'OK' }, { result: 'EXCEPTION' }, { result: null }])).toEqual({ tested: 2, exceptions: 1, remaining: 1 });
  });
});
