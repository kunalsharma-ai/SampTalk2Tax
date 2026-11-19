import { Dec, dec, roundToCurrency } from './money';
import { BILLING_CURRENCIES, BillingCurrency, BillingInterval, PlanError } from './plans';

/**
 * Coupons on Talk2Tax subscriptions (SUBS-024): a percentage or a fixed amount off what a
 * checkout or renewal charges, before tax. Platform administrators create them; an organisation
 * enters the code at checkout. Once paid for, the coupon stays with the subscription and is
 * applied to later renewals until its number of discounted payments is used up.
 *
 * The redeem-by date, the limit on organisations and switching a coupon off stop new
 * organisations from using it; an organisation already using it keeps it for its remaining
 * payments. A coupon never takes a charge to nothing: a free plan is a complimentary
 * subscription instead.
 */

export type CouponKind = 'PERCENT' | 'AMOUNT';

export interface CouponTerms {
  code: string;
  kind: CouponKind;
  percentOff: string | null;
  amountOff: string | null;
  /** The currency of an amount off; a percentage applies in any currency. */
  currency: BillingCurrency | null;
  /** Plan codes it is for; empty for every plan. */
  planCodes: string[];
  /** Billing intervals it is for; empty for both. */
  intervals: BillingInterval[];
  /** How many payments it takes money off for each organisation; null for every payment. */
  cycles: number | null;
  /** How many organisations can use it; null for no limit. */
  maxRedemptions: number | null;
  /** The last moment a new organisation can start using it. */
  redeemBy: Date | null;
  isActive: boolean;
}

export const COUPON_CODE = /^[A-Z0-9][A-Z0-9-]{2,19}$/;

/** Checks and tidies a new coupon's terms. */
export function validateCoupon(input: Omit<CouponTerms, 'isActive'>): Omit<CouponTerms, 'isActive'> {
  const code = input.code.trim().toUpperCase();
  if (!COUPON_CODE.test(code)) throw new PlanError('The code is 3 to 20 letters, digits or hyphens, starting with a letter or digit');
  let percentOff: string | null = null;
  let amountOff: string | null = null;
  let currency: BillingCurrency | null = null;
  if (input.kind === 'PERCENT') {
    const p = parse(input.percentOff, 'The percentage');
    if (p.lt('0.01') || p.gte(100) || p.decimalPlaces() > 2) throw new PlanError('The percentage off is from 0.01 to 99.99; for a free plan give a complimentary subscription');
    percentOff = p.toFixed(2);
  } else if (input.kind === 'AMOUNT') {
    if (!input.currency || !(BILLING_CURRENCIES as readonly string[]).includes(input.currency)) throw new PlanError(`An amount off needs its currency: ${BILLING_CURRENCIES.join(' or ')}`);
    const a = parse(input.amountOff, 'The amount');
    if (a.lte(0) || a.decimalPlaces() > 2 || a.gt('10000000')) throw new PlanError('The amount off is more than zero, with at most two decimals');
    amountOff = a.toFixed(2);
    currency = input.currency;
  } else throw new PlanError('A coupon is a percentage or an amount off');
  const planCodes = [...new Set(input.planCodes.map((c) => c.trim().toUpperCase()).filter(Boolean))].sort();
  const intervals = [...new Set(input.intervals)].sort() as BillingInterval[];
  if (intervals.some((i) => i !== 'MONTHLY' && i !== 'ANNUAL')) throw new PlanError('Billing is monthly or annual');
  if (input.cycles !== null && (!Number.isInteger(input.cycles) || input.cycles < 1 || input.cycles > 36)) throw new PlanError('A coupon takes money off 1 to 36 payments, or every payment');
  if (input.maxRedemptions !== null && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1 || input.maxRedemptions > 100_000)) throw new PlanError('The number of organisations is from 1 to 100,000, or no limit');
  return { code, kind: input.kind, percentOff, amountOff, currency, planCodes, intervals, cycles: input.cycles, maxRedemptions: input.maxRedemptions, redeemBy: input.redeemBy };
}

function parse(v: string | null, what: string): Dec {
  if (v === null || !/^\d+(\.\d+)?$/.test(v.trim())) throw new PlanError(`${what} off is a number`);
  return dec(v.trim());
}

export interface CouponUse {
  planCode: string;
  interval: BillingInterval;
  currency: BillingCurrency;
  now: Date;
  /** Organisations that have used it so far. */
  redemptions: number;
  /** This organisation started using it before (and it is still on the subscription, or was). */
  usedByOrg: boolean;
  /** Payments it has taken money off for this organisation. */
  usesByOrg: number;
}

/**
 * Why the coupon does not apply, or null when it does. A new organisation must find it on
 * offer (switched on, before its redeem-by date, organisations left); one already using it
 * only needs payments left. Either way the plan, billing and currency must fit.
 */
export function couponProblem(c: CouponTerms, u: CouponUse): string | null {
  if (!u.usedByOrg) {
    if (!c.isActive) return 'This coupon is no longer offered';
    if (c.redeemBy && u.now > c.redeemBy) return `This coupon could be used until ${c.redeemBy.toISOString().slice(0, 10)}`;
    if (c.maxRedemptions !== null && u.redemptions >= c.maxRedemptions) return 'This coupon has been used by as many organisations as it allows';
  } else if (c.cycles !== null && u.usesByOrg >= c.cycles) return `This coupon has taken money off all ${c.cycles} payment${c.cycles === 1 ? '' : 's'} it was for`;
  if (c.kind === 'AMOUNT' && c.currency !== u.currency) return `This coupon is for payments in ${c.currency}`;
  if (c.planCodes.length && !c.planCodes.includes(u.planCode)) return `This coupon is for the ${c.planCodes.join(', ')} plan${c.planCodes.length === 1 ? '' : 's'}`;
  if (c.intervals.length && !c.intervals.includes(u.interval)) return `This coupon is for ${c.intervals.map((i) => (i === 'ANNUAL' ? 'annual' : 'monthly')).join(' or ')} billing`;
  return null;
}

/**
 * What the coupon takes off a charge (before tax): the percentage rounded to the currency, or
 * the amount. Refused when it would leave nothing to pay.
 */
export function couponDiscount(c: Pick<CouponTerms, 'kind' | 'percentOff' | 'amountOff'>, amount: string | Dec, currency: BillingCurrency): { discount: Dec; charged: Dec } {
  const gross = dec(String(amount));
  const discount = c.kind === 'PERCENT' ? roundToCurrency(gross.times(c.percentOff!).div(100), currency) : dec(c.amountOff!);
  const charged = gross.minus(discount);
  if (charged.lte(0)) throw new PlanError('The coupon is worth as much as this charge or more, so there would be nothing to pay');
  return { discount, charged };
}

/** "20% off", "₹500.00 off" style wording, with how long it lasts. */
export function describeCoupon(c: Pick<CouponTerms, 'kind' | 'percentOff' | 'amountOff' | 'currency' | 'cycles'>): string {
  const off = c.kind === 'PERCENT' ? `${dec(c.percentOff!).toFixed()}% off` : `${c.currency} ${c.amountOff} off`;
  return `${off} ${c.cycles === null ? 'every payment' : c.cycles === 1 ? 'the first payment' : `the first ${c.cycles} payments`}`;
}
