/**
 * Deterministic test data (QA-031): tests, seeds and load runs that need varied figures draw them
 * from a seeded generator, so a run can be repeated exactly and a failure reproduced from its
 * seed. Uniqueness (emails, references) comes from randomUUID; figures never come from
 * Math.random (scripts/check-test-determinism.mjs).
 * No framework or database code. Money is decimal strings.
 */

/** A seeded generator of numbers in [0, 1) (mulberry32): the same seed gives the same sequence on any machine. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An amount between min and max inclusive, as a decimal string with `scale` places, built from
 * whole minor units so nothing is lost to floating point.
 */
export function fixtureAmount(next: () => number, min: string, max: string, scale = 2): string {
  const units = (v: string) => {
    if (!/^\d{1,13}(\.\d+)?$/.test(v)) throw new RangeError(`"${v}" is not a plain amount`);
    const [w, f = ''] = v.split('.');
    if (f.length > scale) throw new RangeError(`"${v}" has more than ${scale} decimal places`);
    return BigInt(w) * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale) || '0');
  };
  const lo = units(min);
  const hi = units(max);
  if (hi < lo) throw new RangeError(`${max} is below ${min}`);
  const span = hi - lo + 1n;
  // Two draws give 64 bits, so spans up to 10^15 minor units are covered evenly enough for tests.
  const r = (BigInt(Math.floor(next() * 2 ** 32)) << 32n) | BigInt(Math.floor(next() * 2 ** 32));
  const v = lo + (r % span);
  const s = v.toString().padStart(scale + 1, '0');
  return scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
}
