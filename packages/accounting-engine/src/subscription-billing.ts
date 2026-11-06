import { Dec, dec, minorUnits, roundToCurrency } from './money';
import { BillingCurrency, BillingInterval, GRACE_DAYS, PlanError, periodEnd, upgradeCharge } from './plans';

/**
 * Charging organisations for their Talk2Tax subscription: what a checkout charges and for which
 * period, the tax on the invoice, the tax invoice number, and when renewal reminders go out.
 * This is the platform's own billing; nothing here touches an organisation's books.
 */

const DAY = 86_400_000;

/** A renewal is issued this many days before the paid period ends. */
export const RENEWAL_NOTICE_DAYS = 7;
/** The final reminder goes this many days before the grace period ends. */
export const FINAL_NOTICE_DAYS = 2;
/** GST on software as a service supplied from India (SAC 998314 / 997331): 18%. */
export const DEFAULT_SAAS_GST_RATE = '18';

export type CheckoutKind = 'NEW' | 'RENEWAL' | 'UPGRADE';

export interface CheckoutInput {
  status: 'TRIALING' | 'ACTIVE' | 'CANCELLED' | 'COMPLIMENTARY';
  planCode: string;
  interval: BillingInterval | null;
  /** The price of the paid period running now (null outside a paid period). */
  price: string | Dec | null;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  target: { planCode: string; interval: BillingInterval; price: string | Dec };
  currency: BillingCurrency;
  now: Date;
}

export type CheckoutPlan =
  | { kind: CheckoutKind; amount: Dec; periodStart: Date; periodEnd: Date }
  | { kind: 'SCHEDULED'; reason: string };

/**
 * What paying for a plan now buys.
 *
 * - Outside a paid period (a trial, or after a trial, a lapse or a cancellation): a NEW period.
 *   During a trial the paid period starts when the trial ends, so no trial days are lost.
 * - In a paid period (including grace and a cancellation still running), the same plan and
 *   billing: a RENEWAL for the next period, straight after the current one.
 * - A dearer plan with the same billing before the period ends: an UPGRADE now, charged for the
 *   days left (upgradeCharge), ending with the current period.
 * - A cheaper plan or another billing interval in a paid period: SCHEDULED, taking effect at the
 *   renewal (nothing is charged now and no credit is given).
 */
export function checkoutPlan(i: CheckoutInput): CheckoutPlan {
  if (i.status === 'COMPLIMENTARY') throw new PlanError('A complimentary subscription is not charged');
  const price = dec(String(i.target.price));
  if (price.lte(0)) throw new PlanError('The plan has no price');
  const paid = (i.status === 'ACTIVE' || i.status === 'CANCELLED') && i.currentPeriodEnd && i.currentPeriodStart && i.price !== null;
  const graceEnd = paid ? new Date(i.currentPeriodEnd!.getTime() + GRACE_DAYS * DAY) : null;
  const inPaidPeriod = paid && i.now < graceEnd! && (i.status === 'ACTIVE' || i.now < i.currentPeriodEnd!);
  if (!inPaidPeriod) {
    const start = i.status === 'TRIALING' && i.trialEndsAt && i.trialEndsAt > i.now ? i.trialEndsAt : i.now;
    return { kind: 'NEW', amount: price, periodStart: start, periodEnd: periodEnd(start, i.target.interval) };
  }
  const end = i.currentPeriodEnd!;
  const sameBilling = i.interval === i.target.interval;
  if (sameBilling && i.planCode === i.target.planCode) return { kind: 'RENEWAL', amount: price, periodStart: end, periodEnd: periodEnd(end, i.target.interval) };
  const current = dec(String(i.price));
  if (sameBilling && price.gt(current)) {
    if (i.now < end) {
      const amount = upgradeCharge({ currentPrice: current, newPrice: price, periodStart: i.currentPeriodStart!, periodEnd: end, now: i.now, currency: i.currency });
      if (amount.gt(0)) return { kind: 'UPGRADE', amount, periodStart: i.now, periodEnd: end };
    }
    return { kind: 'RENEWAL', amount: price, periodStart: end, periodEnd: periodEnd(end, i.target.interval) };
  }
  return {
    kind: 'SCHEDULED',
    reason: !sameBilling ? 'A change of billing takes effect at the renewal' : 'A cheaper plan takes effect at the renewal; the current plan runs to the end of the period paid for',
  };
}

export interface TaxParty {
  countryCode: string;
  gstin?: string | null;
  /** The two-digit GST state code (27 Maharashtra, 29 Karnataka…). */
  stateCode?: string | null;
}

export interface InvoiceTax {
  lines: { code: 'CGST' | 'SGST' | 'IGST'; rate: string; amount: string }[];
  taxTotal: string;
  total: string;
  /** Printed on the invoice: why no tax is charged, or the place of supply. */
  note: string;
  placeOfSupply: string | null;
}

/**
 * Tax on a subscription invoice. Plan prices exclude tax.
 *
 * From an Indian supplier registered for GST: CGST and SGST when the customer is in the
 * supplier's state (or its state is not known, so the supplier's location is the place of
 * supply), IGST when it is in another state, and no tax on an export of services to a customer
 * outside India, which is zero-rated under a bond or letter of undertaking. A supplier outside
 * India, or not registered, charges no tax here; the invoice says so.
 */
export function subscriptionTax(input: { seller: TaxParty; buyer: TaxParty; subtotal: string | Dec; currency: BillingCurrency; gstRate?: string }): InvoiceTax {
  const subtotal = dec(String(input.subtotal));
  const none = (note: string, placeOfSupply: string | null = null): InvoiceTax => ({ lines: [], taxTotal: '0.00', total: subtotal.toFixed(2), note, placeOfSupply });
  const seller = input.seller;
  if (seller.countryCode.toUpperCase() !== 'IN') return none('Tax not charged by the supplier on this invoice');
  if (!seller.gstin || !seller.stateCode) return none('Supplier not registered for GST');
  const rate = dec(input.gstRate ?? DEFAULT_SAAS_GST_RATE);
  if (rate.lt(0) || rate.gt(28)) throw new PlanError('The GST rate must be from 0 to 28');
  if (input.buyer.countryCode.toUpperCase() !== 'IN') return none('Supply meant for export under bond or letter of undertaking without payment of integrated tax', 'Outside India');
  const buyerState = input.buyer.stateCode || seller.stateCode;
  const pct = (r: Dec) => roundToCurrency(subtotal.times(r).div(100), input.currency);
  let lines: InvoiceTax['lines'];
  if (buyerState === seller.stateCode) {
    const half = rate.div(2);
    const each = pct(half);
    lines = [
      { code: 'CGST', rate: half.toFixed(), amount: each.toFixed(2) },
      { code: 'SGST', rate: half.toFixed(), amount: each.toFixed(2) },
    ];
  } else {
    lines = [{ code: 'IGST', rate: rate.toFixed(), amount: pct(rate).toFixed(2) }];
  }
  const taxTotal = lines.reduce((s, l) => s.plus(l.amount), dec('0'));
  return { lines, taxTotal: taxTotal.toFixed(2), total: subtotal.plus(taxTotal).toFixed(2), note: '', placeOfSupply: `State code ${buyerState}` };
}

/** The Indian financial year (April to March) a moment falls in, by its date in India. */
export function indianFinancialYear(at: Date): { start: number; label: string } {
  const ist = new Date(at.getTime() + 5.5 * 3_600_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return { start, label: `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}` };
}

/**
 * A tax invoice number: prefix, financial year and a running number, such as T2T/26-27/00042.
 * GST allows at most 16 characters, unique in the financial year; a new series starts each year.
 */
export function taxInvoiceNumber(prefix: string, fyLabel: string, seq: number): string {
  if (!/^[A-Z0-9]{1,4}$/.test(prefix)) throw new PlanError('The invoice prefix is 1-4 capital letters or digits');
  if (!Number.isInteger(seq) || seq < 1) throw new PlanError('The running number starts at 1');
  const n = `${prefix}/${fyLabel}/${String(seq).padStart(5, '0')}`;
  if (n.length > 16) throw new PlanError('The invoice number would be longer than 16 characters; use a shorter prefix');
  return n;
}

/** An amount in the currency's smallest unit (paise, cents), as payment gateways take it. */
export function toMinorUnits(amount: string | Dec, currency: BillingCurrency): number {
  const scaled = dec(String(amount)).times(dec('10').pow(minorUnits(currency)));
  if (!scaled.isInteger()) throw new PlanError(`The amount has more decimals than ${currency} allows`);
  if (scaled.lte(0)) throw new PlanError('The amount must be more than zero');
  return scaled.toNumber();
}

export type DunningStage = 'UPCOMING' | 'DUE' | 'FINAL' | 'LAPSED';

/**
 * Where a subscription with an unpaid renewal stands: UPCOMING in the last RENEWAL_NOTICE_DAYS
 * of the period, DUE once the period has ended (grace), FINAL in the last FINAL_NOTICE_DAYS of
 * grace, LAPSED after grace (the books are then read-only). Null before the notice window.
 */
export function dunningStage(currentPeriodEnd: Date, now: Date): DunningStage | null {
  const end = currentPeriodEnd.getTime();
  const graceEnd = end + GRACE_DAYS * DAY;
  const t = now.getTime();
  if (t < end - RENEWAL_NOTICE_DAYS * DAY) return null;
  if (t < end) return 'UPCOMING';
  if (t >= graceEnd) return 'LAPSED';
  if (t >= graceEnd - FINAL_NOTICE_DAYS * DAY) return 'FINAL';
  return 'DUE';
}
