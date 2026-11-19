import { dec } from './money';
import { BillingInterval, PlanLimits } from './plans';

/**
 * Enterprise contracts (SUBS-023): a plan agreed with one organisation for a term, at its own
 * price per billing period, with limits that may differ from the plan's. While a contract runs,
 * renewals are invoiced at its price and the organisation cannot change plan itself; when its
 * term ends, the next renewal is at the plan's list price.
 */
export interface ContractInput {
  reference: string;
  interval: BillingInterval;
  price: string;
  startsOn: string;
  endsOn: string;
  /** Limits that differ from the plan's; a limit left out is the plan's. */
  limits: Partial<Record<keyof PlanLimits, number>>;
}

export const CONTRACT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{2,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIMIT_KEYS: (keyof PlanLimits)[] = ['members', 'aiCreditsPerMonth', 'documentUploadsPerMonth'];

/** Checks a contract before it is saved; returns the problems. */
export function contractProblems(c: ContractInput): string[] {
  const out: string[] = [];
  if (!CONTRACT_REFERENCE.test(c.reference ?? '')) out.push('A contract reference is 3 to 40 letters, digits or / _ . -');
  if (c.interval !== 'MONTHLY' && c.interval !== 'ANNUAL') out.push('Billing is monthly or annual');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(c.price ?? '') || dec(c.price).lte(0)) out.push('The price must be more than zero, with at most 2 decimals');
  const valid = (d: string) => DATE.test(d ?? '') && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
  if (!valid(c.startsOn)) out.push('The start is a date written YYYY-MM-DD');
  if (!valid(c.endsOn)) out.push('The end is a date written YYYY-MM-DD');
  else if (valid(c.startsOn) && c.endsOn <= c.startsOn) out.push('The term ends after it starts');
  for (const [k, v] of Object.entries(c.limits ?? {})) {
    if (!LIMIT_KEYS.includes(k as keyof PlanLimits)) out.push(`${k} is not a plan limit`);
    else if (!Number.isInteger(v) || v < 0 || v > 10_000_000) out.push(`${k} must be a whole number, zero or more`);
  }
  return out;
}

/** Contract dates run on India time, like every business date: the instant a date starts. */
export function contractInstant(date: string): Date {
  return new Date(`${date}T00:00:00+05:30`);
}

/** Whether a contract's term covers an instant (its end date is the first day it no longer does). */
export function contractCovers(c: { startsOn: Date; endsOn: Date }, at: Date): boolean {
  return at >= c.startsOn && at < c.endsOn;
}

/** The plan's limits with the contract's in their place. */
export function contractLimits(plan: PlanLimits, overrides: Partial<Record<keyof PlanLimits, number>> | null | undefined): PlanLimits {
  return { ...plan, ...(overrides ?? {}) };
}
