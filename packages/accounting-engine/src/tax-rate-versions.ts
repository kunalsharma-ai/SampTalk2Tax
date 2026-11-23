import { D, dec } from './money';

/**
 * Effective-dated, version-controlled tax rates (TAX-003). A tax rate keeps the percentage it was
 * created with (version 1, in force from the start) and a history of later versions, each with the
 * date it takes effect and why. The rate for a transaction is the one in force on its date, so a
 * rate change never alters documents already recorded, and a change can be set up ahead of the date
 * it takes effect. Versions are only ever appended: the history is never rewritten, and a version
 * can be withdrawn only before it takes effect.
 */
export interface RateVersion {
  /** YYYY-MM-DD, the first day the rate applies. */
  effectiveFrom: string;
  /** Percentage as a decimal string. */
  rate: string;
}

/** The rate in force on `date`: the latest version from on or before that date, else the original rate. */
export function rateEffectiveOn(baseRate: string, versions: readonly RateVersion[], date: string): string {
  let best: RateVersion | null = null;
  for (const v of versions) if (v.effectiveFrom <= date && (!best || v.effectiveFrom > best.effectiveFrom)) best = v;
  return dec(best ? best.rate : baseRate).toFixed();
}

/** The next version after `date`, if one is set up. */
export function nextRateChange(versions: readonly RateVersion[], date: string): RateVersion | null {
  let next: RateVersion | null = null;
  for (const v of versions) if (v.effectiveFrom > date && (!next || v.effectiveFrom < next.effectiveFrom)) next = v;
  return next;
}

export interface RateVersionCheck {
  baseRate: string;
  /** Only TAXABLE GST rates and simple rates can change; nil-rated, exempt and non-GST stay at 0%. */
  fixedAtZero: boolean;
  versions: readonly RateVersion[];
  /** Posted documents and claims that use the rate dated on or after the new version's date. */
  usedOnOrAfter: number;
}

/** Why a new version cannot be added (empty when it can). */
export function rateVersionIssues(c: RateVersionCheck, input: RateVersion): string[] {
  const issues: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || Number.isNaN(Date.parse(`${input.effectiveFrom}T00:00:00Z`))) issues.push('The date it takes effect must be YYYY-MM-DD');
  let rate: InstanceType<typeof D> | null = null;
  try {
    rate = dec(input.rate);
  } catch {
    issues.push('The rate must be a number');
  }
  if (rate && (rate.lt(0) || rate.gt(100))) issues.push('A tax rate is between 0% and 100%');
  if (c.fixedAtZero) issues.push('Nil-rated, exempt and non-GST rates stay at 0%; create a new rate instead');
  const latest = c.versions.reduce<RateVersion | null>((m, v) => (!m || v.effectiveFrom > m.effectiveFrom ? v : m), null);
  if (latest && input.effectiveFrom <= latest.effectiveFrom) issues.push(`Versions are added in date order: the latest takes effect on ${latest.effectiveFrom}, so a new one must start after that`);
  if (rate && !issues.length) {
    const before = rateEffectiveOn(c.baseRate, c.versions, input.effectiveFrom);
    if (dec(before).eq(rate)) issues.push(`The rate is already ${before}% on ${input.effectiveFrom}`);
  }
  if (c.usedOnOrAfter > 0) issues.push(`${c.usedOnOrAfter} posted ${c.usedOnOrAfter === 1 ? 'document or claim uses' : 'documents or claims use'} this rate on or after ${input.effectiveFrom}; a change cannot reach back past them`);
  return issues;
}

export interface RateTimelineEntry {
  version: number; // not money
  rate: string;
  /** null for the original rate, in force from the start. */
  effectiveFrom: string | null;
  /** The day before the next version takes effect; null while it is the latest. */
  effectiveTo: string | null;
  state: 'PAST' | 'CURRENT' | 'SCHEDULED';
}

const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The rate's history in order, each version marked past, current or scheduled as of `today`. */
export function rateTimeline(baseRate: string, versions: readonly RateVersion[], today: string): RateTimelineEntry[] {
  const sorted = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const all = [{ rate: dec(baseRate).toFixed(), effectiveFrom: null as string | null }, ...sorted.map((v) => ({ rate: dec(v.rate).toFixed(), effectiveFrom: v.effectiveFrom as string | null }))];
  return all.map((v, i) => {
    const next = all[i + 1]?.effectiveFrom ?? null;
    const started = v.effectiveFrom === null || v.effectiveFrom <= today;
    const ended = next !== null && next <= today;
    return { version: i + 1, rate: v.rate, effectiveFrom: v.effectiveFrom, effectiveTo: next ? dayBefore(next) : null, state: !started ? 'SCHEDULED' : ended ? 'PAST' : 'CURRENT' };
  });
}
