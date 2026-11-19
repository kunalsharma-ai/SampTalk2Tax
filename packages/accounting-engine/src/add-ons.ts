import { Dec, dec } from './money';
import { BILLING_CURRENCIES, BillingCurrency, BillingInterval, PLAN_FEATURE_LABELS, PlanError, PlanFeature } from './plans';

/**
 * Add-on modules (SUBS-017): a module a plan does not include, bought on top of it for its own
 * price each month or year. Payroll, foreign currencies and group consolidation can be added;
 * the AI assistant cannot, because what it may use is a plan's monthly AI requests, which an
 * add-on would leave undefined.
 */
export const ADD_ON_FEATURES = ['PAYROLL', 'MULTI_CURRENCY', 'CONSOLIDATION'] as const satisfies readonly PlanFeature[];
export type AddOnFeature = (typeof ADD_ON_FEATURES)[number];

export interface AddOnOffer {
  feature: AddOnFeature;
  prices: Record<BillingCurrency, { monthly: string; annual: string }>;
  isActive: boolean;
}

export const isAddOnFeature = (f: string): f is AddOnFeature => (ADD_ON_FEATURES as readonly string[]).includes(f);

/** Checks an add-on's prices before they are saved; returns the problems. */
export function addOnProblems(o: Pick<AddOnOffer, 'feature' | 'prices'>): string[] {
  const out: string[] = [];
  if (!isAddOnFeature(o.feature)) out.push(`${o.feature} cannot be bought as an add-on`);
  for (const c of BILLING_CURRENCIES) {
    const p = o.prices?.[c];
    if (!p) {
      out.push(`A ${c} price is needed`);
      continue;
    }
    for (const k of ['monthly', 'annual'] as const) {
      if (!/^\d{1,9}(\.\d{1,2})?$/.test(p[k] ?? '') || dec(p[k]).lte(0)) out.push(`${c} ${k} price must be more than zero, with at most 2 decimals`);
    }
  }
  return out;
}

/**
 * The add-ons chosen for a plan, checked and in a fixed order: each must be on offer, not
 * already in the plan, and listed once.
 */
export function chooseAddOns(planFeatures: readonly string[], chosen: readonly string[], offers: readonly Pick<AddOnOffer, 'feature' | 'isActive'>[]): AddOnFeature[] {
  const seen = new Set<string>();
  for (const f of chosen) {
    if (seen.has(f)) throw new PlanError(`${label(f)} is chosen twice`);
    seen.add(f);
    if (!isAddOnFeature(f)) throw new PlanError(`${label(f)} cannot be bought as an add-on`);
    if (planFeatures.includes(f)) throw new PlanError(`The plan already includes ${label(f)}`);
    if (!offers.some((o) => o.feature === f && o.isActive)) throw new PlanError(`${label(f)} is not offered as an add-on`);
  }
  return ADD_ON_FEATURES.filter((f) => seen.has(f));
}

/** What the add-ons cost a period, one line each. */
export function addOnLines(addOns: readonly AddOnFeature[], offers: readonly Pick<AddOnOffer, 'feature' | 'prices'>[], currency: BillingCurrency, interval: BillingInterval): { feature: AddOnFeature; label: string; price: string }[] {
  return addOns.map((f) => {
    const o = offers.find((x) => x.feature === f);
    if (!o) throw new PlanError(`${label(f)} has no price`);
    const p = o.prices[currency];
    if (!p) throw new PlanError(`${label(f)} has no ${currency} price`);
    return { feature: f, label: label(f), price: dec(interval === 'MONTHLY' ? p.monthly : p.annual).toFixed(2) };
  });
}

/** The plan's price with its add-ons. */
export function priceWithAddOns(planPrice: string | Dec, lines: readonly { price: string }[]): Dec {
  return lines.reduce((s, l) => s.plus(l.price), dec(String(planPrice)));
}

/** The modules an organisation may use: its plan's and its add-ons'. */
export function effectiveFeatures(planFeatures: readonly string[], addOns: readonly string[] | null | undefined): string[] {
  return [...new Set([...planFeatures, ...(addOns ?? [])])];
}

/** Whether two add-on lists are the same set. */
export function sameAddOns(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = [...new Set(a ?? [])].sort();
  const y = [...new Set(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function label(f: string) {
  return (PLAN_FEATURE_LABELS as Record<string, string>)[f] ?? f;
}
