import { Dec, dec, roundToCurrency } from './money';

/**
 * Talk2Tax's own subscription plans (platform billing, never an organisation's books).
 *
 * A plan has prices per billing currency (INR for organisations in India, USD elsewhere) for
 * monthly and annual billing, limits, and the modules it includes. Each organisation has one
 * subscription. Whether it may change its books follows from the subscription's status and
 * dates (subscriptionAccess); reading and exporting are never blocked.
 */

export const PLAN_FEATURES = ['AI', 'PAYROLL', 'MULTI_CURRENCY', 'CONSOLIDATION'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  AI: 'AI assistant and agents (copilot, collections, reconciliation suggestions, close review, virtual CFO)',
  PAYROLL: 'Payroll',
  MULTI_CURRENCY: 'Exchange rates and revaluation',
  CONSOLIDATION: 'Group consolidation and intercompany',
};

export const BILLING_CURRENCIES = ['INR', 'USD'] as const;
export type BillingCurrency = (typeof BILLING_CURRENCIES)[number];
export type BillingInterval = 'MONTHLY' | 'ANNUAL';

export interface PlanLimits {
  /** Most members an organisation may have; null for no limit. */
  members: number | null;
  /** AI questions and agent runs a month (counted from the usage slice); null for no limit. */
  aiCreditsPerMonth: number | null;
  /** Attachments uploaded a month; null for no limit. */
  documentUploadsPerMonth: number | null;
}

export interface PlanDefinition {
  code: string;
  name: string;
  description: string;
  /** Per currency: price a month when billed monthly, and a year when billed annually. */
  prices: Record<BillingCurrency, { monthly: string; annual: string }>;
  limits: PlanLimits;
  features: PlanFeature[];
}

/**
 * The directive's proposed launch prices (not final validated commercial rates, SUBS-010).
 * Annual billing is ten months' price. Limits and modules are Talk2Tax's starting choice and
 * are edited by platform administrators.
 */
export const DEFAULT_PLANS: PlanDefinition[] = [
  {
    code: 'STARTER',
    name: 'Starter',
    description: 'Bookkeeping, invoicing, banking, GST and reports for a small business.',
    prices: { INR: { monthly: '499', annual: '4990' }, USD: { monthly: '9', annual: '90' } },
    limits: { members: 2, aiCreditsPerMonth: null, documentUploadsPerMonth: 100 },
    features: [],
  },
  {
    code: 'GROWTH',
    name: 'Growth',
    description: 'Adds the AI assistant and agents, and more people.',
    prices: { INR: { monthly: '1499', annual: '14990' }, USD: { monthly: '25', annual: '250' } },
    limits: { members: 5, aiCreditsPerMonth: 300, documentUploadsPerMonth: 500 },
    features: ['AI'],
  },
  {
    code: 'PROFESSIONAL',
    name: 'Professional',
    description: 'Adds payroll and foreign currencies for a growing finance team.',
    prices: { INR: { monthly: '3499', annual: '34990' }, USD: { monthly: '59', annual: '590' } },
    limits: { members: 15, aiCreditsPerMonth: 1500, documentUploadsPerMonth: 2000 },
    features: ['AI', 'PAYROLL', 'MULTI_CURRENCY'],
  },
  {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    description: 'Every module, including group consolidation, without member limits.',
    prices: { INR: { monthly: '8999', annual: '89990' }, USD: { monthly: '149', annual: '1490' } },
    limits: { members: null, aiCreditsPerMonth: 5000, documentUploadsPerMonth: null },
    features: ['AI', 'PAYROLL', 'MULTI_CURRENCY', 'CONSOLIDATION'],
  },
];

/** The plan a new organisation's trial runs on: every module, so nothing is hidden while trying. */
export const TRIAL_PLAN_CODE = 'ENTERPRISE';
export const DEFAULT_TRIAL_DAYS = 14;
/** Days after a paid period ends before the books become read-only (payment failures, renewals). */
export const GRACE_DAYS = 7;

export class PlanError extends Error {}

/** Organisations in India are billed in rupees; everyone else in US dollars. */
export function billingCurrencyFor(countryCode: string): BillingCurrency {
  return countryCode.toUpperCase() === 'IN' ? 'INR' : 'USD';
}

export function priceFor(plan: Pick<PlanDefinition, 'prices'>, currency: BillingCurrency, interval: BillingInterval): Dec {
  const p = plan.prices[currency];
  if (!p) throw new PlanError(`The plan has no ${currency} price`);
  return dec(interval === 'MONTHLY' ? p.monthly : p.annual);
}

/** Checks a plan before it is saved. Returns the problems, empty when it is valid. */
export function planProblems(p: PlanDefinition): string[] {
  const out: string[] = [];
  if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(p.code)) out.push('The code is 2-24 capital letters, digits or underscores, starting with a letter');
  if (!p.name.trim() || p.name.length > 60) out.push('The name is 1-60 characters');
  if (p.description.length > 300) out.push('The description is at most 300 characters');
  for (const c of BILLING_CURRENCIES) {
    const pr = p.prices?.[c];
    if (!pr) {
      out.push(`A ${c} price is needed`);
      continue;
    }
    for (const k of ['monthly', 'annual'] as const) {
      if (!/^\d{1,9}(\.\d{1,2})?$/.test(pr[k] ?? '') || dec(pr[k]).lte(0)) out.push(`${c} ${k} price must be more than zero, with at most 2 decimals`);
    }
  }
  for (const [k, v] of Object.entries(p.limits ?? {})) {
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 1_000_000)) out.push(`Limit ${k} must be a whole number from 1, or no limit`);
  }
  for (const k of ['members', 'aiCreditsPerMonth', 'documentUploadsPerMonth'] as const) if (!(k in (p.limits ?? {}))) out.push(`Limit ${k} is missing`);
  const unknown = p.features.filter((f) => !(PLAN_FEATURES as readonly string[]).includes(f));
  if (unknown.length) out.push(`Unknown modules: ${unknown.join(', ')}`);
  if (new Set(p.features).size !== p.features.length) out.push('A module is listed twice');
  return out;
}

const DAY = 86_400_000;

/** The end of a billing period that starts at `start`: one calendar month or year later (end of month kept). */
export function periodEnd(start: Date, interval: BillingInterval): Date {
  const months = interval === 'MONTHLY' ? 1 : 12;
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(start.getUTCDate(), lastDay);
  return new Date(Date.UTC(y, m, d, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
}

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'CANCELLED' | 'COMPLIMENTARY';

export interface SubscriptionDates {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

export type Access =
  | { level: 'FULL'; state: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'CANCELLING' | 'COMPLIMENTARY'; until: Date | null; daysLeft: number | null }
  | { level: 'READ_ONLY'; state: 'TRIAL_ENDED' | 'LAPSED' | 'CANCELLED'; since: Date | null };

/**
 * What a subscription allows now. FULL lets the organisation change its books; READ_ONLY keeps
 * every record readable and exportable but refuses changes until a plan is active again.
 */
export function subscriptionAccess(s: SubscriptionDates, now: Date): Access {
  const days = (until: Date) => Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY));
  switch (s.status) {
    case 'COMPLIMENTARY':
      return { level: 'FULL', state: 'COMPLIMENTARY', until: null, daysLeft: null };
    case 'TRIALING':
      if (!s.trialEndsAt) throw new PlanError('A trial needs an end date');
      return now < s.trialEndsAt ? { level: 'FULL', state: 'TRIAL', until: s.trialEndsAt, daysLeft: days(s.trialEndsAt) } : { level: 'READ_ONLY', state: 'TRIAL_ENDED', since: s.trialEndsAt };
    case 'ACTIVE': {
      if (!s.currentPeriodEnd) throw new PlanError('An active subscription needs a period end');
      if (now < s.currentPeriodEnd) return { level: 'FULL', state: 'ACTIVE', until: s.currentPeriodEnd, daysLeft: days(s.currentPeriodEnd) };
      const grace = new Date(s.currentPeriodEnd.getTime() + GRACE_DAYS * DAY);
      return now < grace ? { level: 'FULL', state: 'GRACE', until: grace, daysLeft: days(grace) } : { level: 'READ_ONLY', state: 'LAPSED', since: grace };
    }
    case 'CANCELLED':
      if (s.currentPeriodEnd && now < s.currentPeriodEnd) return { level: 'FULL', state: 'CANCELLING', until: s.currentPeriodEnd, daysLeft: days(s.currentPeriodEnd) };
      return { level: 'READ_ONLY', state: 'CANCELLED', since: s.currentPeriodEnd };
  }
}

/**
 * The amount due to move to a dearer plan part-way through a paid period: the new plan's price
 * for the days left, less the unused part of the current plan, rounded to the currency.
 * Never negative (a cheaper plan starts at the next period instead).
 */
export function upgradeCharge(input: { currentPrice: string | Dec; newPrice: string | Dec; periodStart: Date; periodEnd: Date; now: Date; currency: BillingCurrency }): Dec {
  const total = input.periodEnd.getTime() - input.periodStart.getTime();
  if (total <= 0) throw new PlanError('The period must end after it starts');
  const left = Math.min(Math.max(input.periodEnd.getTime() - input.now.getTime(), 0), total);
  const share = dec(String(left)).div(String(total));
  const due = dec(String(input.newPrice)).minus(dec(String(input.currentPrice))).times(share);
  return due.lte(0) ? dec('0') : roundToCurrency(due, input.currency);
}

/** True when the change is to a plan that costs less (it then starts at the next period). */
export function isDowngrade(currentPrice: string | Dec, newPrice: string | Dec): boolean {
  return dec(String(newPrice)).lt(dec(String(currentPrice)));
}
