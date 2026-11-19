import { dec } from './money';
import { BILLING_CURRENCIES, BillingCurrency } from './plans';

/**
 * Extra AI requests (SUBS-018): packs of requests bought on top of a plan's monthly AI requests.
 * The plan's requests are used first each month; once they run out, each answered model call
 * takes one request from the bought ones, from the pack that expires first. A pack is valid for
 * a year from its purchase and is not refunded when it expires unused.
 */
export const AI_CREDIT_VALIDITY_DAYS = 365;

export interface AiCreditPackInput {
  name: string;
  requests: number;
  prices: Record<BillingCurrency, string>;
}

/** Checks a pack before it is saved; returns the problems. */
export function creditPackProblems(p: AiCreditPackInput): string[] {
  const out: string[] = [];
  if (!p.name?.trim() || p.name.trim().length > 60) out.push('A pack needs a name of up to 60 characters');
  if (!Number.isInteger(p.requests) || p.requests < 10 || p.requests > 1_000_000) out.push('A pack holds a whole number of requests, from 10 to 1,000,000');
  for (const c of BILLING_CURRENCIES) {
    const v = p.prices?.[c];
    if (!v) out.push(`A ${c} price is needed`);
    else if (!/^\d{1,9}(\.\d{1,2})?$/.test(v) || dec(v).lte(0)) out.push(`The ${c} price must be more than zero, with at most 2 decimals`);
  }
  return out;
}

export interface CreditGrant {
  id: string;
  requests: number;
  used: number;
  grantedAt: Date;
  expiresAt: Date;
}

/** When a pack bought at this instant expires. */
export function creditExpiry(grantedAt: Date): Date {
  return new Date(grantedAt.getTime() + AI_CREDIT_VALIDITY_DAYS * 86_400_000);
}

/** The requests a grant still has, or 0 once it has expired. */
export function creditsLeft(g: CreditGrant, now: Date): number {
  return g.expiresAt > now ? Math.max(0, g.requests - g.used) : 0;
}

/** The bought requests still usable. */
export function creditBalance(grants: readonly CreditGrant[], now: Date): number {
  return grants.reduce((s, g) => s + creditsLeft(g, now), 0);
}

/** The grant the next request comes from: the one expiring first that has requests left; null when none has. */
export function pickCreditGrant<G extends CreditGrant>(grants: readonly G[], now: Date): G | null {
  const usable = grants.filter((g) => creditsLeft(g, now) > 0);
  usable.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.grantedAt.getTime() - b.grantedAt.getTime());
  return usable[0] ?? null;
}

/** What a request costs in a pack, to two decimals, for showing beside it. */
export function pricePerRequest(price: string, requests: number): string {
  return dec(price).div(requests).toFixed(2);
}
