/**
 * Audit sampling (AUDIT-009): pick transactions to test from a period's population, so a sample
 * can be drawn again from its seed and checked by someone else. Three methods:
 *
 * - RANDOM: simple random sampling without replacement; every item has the same chance.
 * - MONETARY_UNIT: each currency unit has the same chance, so larger items are likelier (systematic
 *   selection from a random start); an item larger than the interval is always picked.
 * - HIGH_VALUE: every item at or above a threshold, then a random sample of the rest.
 *
 * Sampling is seeded with a small deterministic generator (not for security): the seed is kept
 * with the sample so the same population gives the same items.
 */
import { seededRandom } from './fixtures';
import { D, type Dec } from './money';

export const SAMPLE_METHODS = ['RANDOM', 'MONETARY_UNIT', 'HIGH_VALUE'] as const;
export type SampleMethod = (typeof SAMPLE_METHODS)[number];
export const SAMPLE_POPULATIONS = ['JOURNALS', 'BILLS', 'INVOICES', 'PAYMENTS'] as const;
export type SamplePopulation = (typeof SAMPLE_POPULATIONS)[number];
export const MAX_SAMPLE_SIZE = 200;

export interface PopulationItem {
  id: string;
  amount: string;
}

/** A 32-bit hash of a string (xmur3), used to seed the generator. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** A deterministic generator of numbers in [0, 1) from a text seed (the fixtures' mulberry32, seeded by a hash of the text). */
export function sampleRandom(seed: string): () => number {
  return seededRandom(hashSeed(seed));
}

/** Picks `n` distinct items at random (partial Fisher-Yates over a copy sorted by id, so input order does not matter). */
function randomPick<T extends PopulationItem>(items: T[], n: number, rnd: () => number): T[] {
  const pool = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, k);
}

const abs = (s: string): Dec => new D(s).abs();

export interface SampleResult<T> {
  items: (T & { reason: 'RANDOM' | 'MONETARY_UNIT' | 'HIGH_VALUE' | 'ABOVE_INTERVAL' })[];
  /** Monetary unit sampling: the sampling interval. */
  interval: string | null;
}

/** Draws a sample. The same population, method, size, threshold and seed always give the same items. */
export function drawSample<T extends PopulationItem>(population: T[], method: SampleMethod, size: number, seed: string, threshold?: string | null): SampleResult<T> {
  if (!Number.isInteger(size) || size < 1 || size > MAX_SAMPLE_SIZE) throw new Error(`Sample size is 1 to ${MAX_SAMPLE_SIZE}`);
  const rnd = sampleRandom(seed);
  if (method === 'RANDOM') return { items: randomPick(population, size, rnd).map((i) => ({ ...i, reason: 'RANDOM' as const })), interval: null };
  if (method === 'HIGH_VALUE') {
    if (threshold == null) throw new Error('A high-value sample needs a threshold');
    const t = new D(threshold);
    const high = population.filter((i) => abs(i.amount).gte(t)).sort((a, b) => abs(b.amount).cmp(abs(a.amount)) || (a.id < b.id ? -1 : 1));
    const rest = population.filter((i) => abs(i.amount).lt(t));
    return { items: [...high.map((i) => ({ ...i, reason: 'HIGH_VALUE' as const })), ...randomPick(rest, Math.max(0, size - high.length), rnd).map((i) => ({ ...i, reason: 'RANDOM' as const }))], interval: null };
  }
  const items = [...population].filter((i) => !abs(i.amount).isZero()).sort((a, b) => (a.id < b.id ? -1 : 1));
  const total = items.reduce((s, i) => s.plus(abs(i.amount)), new D(0));
  if (total.isZero()) return { items: [], interval: null };
  const interval = total.div(Math.min(size, items.length));
  let point = interval.times(rnd());
  let cumulative = new D(0);
  const out: SampleResult<T>['items'] = [];
  for (const i of items) {
    const a = abs(i.amount);
    const next = cumulative.plus(a);
    if (point.lt(next)) {
      out.push({ ...i, reason: a.gte(interval) ? 'ABOVE_INTERVAL' : 'MONETARY_UNIT' });
      while (point.lt(next)) point = point.plus(interval);
    }
    cumulative = next;
  }
  return { items: out, interval: interval.toFixed(2) };
}

/** A fingerprint of a population (ids and amounts), to show whether it changed since a sample was drawn. */
export function populationFingerprint(population: PopulationItem[]): string {
  const text = [...population].sort((a, b) => (a.id < b.id ? -1 : 1)).map((i) => `${i.id}:${new D(i.amount).toFixed()}`).join('|');
  const h1 = hashSeed(text).toString(16).padStart(8, '0');
  const h2 = hashSeed(`${text}#`).toString(16).padStart(8, '0');
  return `${population.length}-${h1}${h2}`;
}

/** Where a sample stands from its items' results. */
export function sampleProgress(items: { result: 'OK' | 'EXCEPTION' | null }[]) {
  const tested = items.filter((i) => i.result).length;
  return { tested, exceptions: items.filter((i) => i.result === 'EXCEPTION').length, remaining: items.length - tested };
}
