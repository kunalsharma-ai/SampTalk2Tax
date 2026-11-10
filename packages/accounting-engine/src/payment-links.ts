/**
 * Payment links (AR-018): a link to the organisation's own payment gateway page (Stripe or
 * Razorpay) where a customer pays an invoice. Amounts go to the gateway in minor units (paise,
 * cents); what the gateway says was paid comes back the same way.
 */
import { D, Dec, minorUnits } from './money';

export type PaymentLinkStatus = 'OPEN' | 'PAID' | 'CANCELLED' | 'EXPIRED';
export const PAYMENT_LINK_STATUS_LABEL: Record<PaymentLinkStatus, string> = { OPEN: 'Open', PAID: 'Paid', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
export const paymentLinkRef = (n: number) => `PL-${String(n).padStart(4, '0')}`;

/** An amount in a currency's minor units, as gateways take it (₹1,234.50 is 123450). */
export function amountToMinor(amount: string | Dec, currency: string): number {
  return new D(amount.toString()).times(new D(10).pow(minorUnits(currency))).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber();
}

/** Minor units back to an amount, as a decimal string. */
export function minorToAmount(minor: number, currency: string): string {
  const s = minorUnits(currency);
  return new D(minor).div(new D(10).pow(s)).toFixed(s);
}

/** Problems with the amount asked for on a link, as sentences. */
export function linkAmountIssues(amount: string, outstanding: string, currency: string): string[] {
  const a = new D(amount || '0');
  const issues: string[] = [];
  if (a.lte(0)) issues.push('The amount must be above zero');
  if (a.decimalPlaces() > minorUnits(currency)) issues.push(`Use at most ${minorUnits(currency)} decimal places`);
  if (a.gt(outstanding)) issues.push(`Only ${new D(outstanding).toFixed(minorUnits(currency))} is still owed on this invoice`);
  return issues;
}

/** Whether an open link has passed its expiry. */
export function linkExpired(status: PaymentLinkStatus, expiresAt: Date | null, now: Date): boolean {
  return status === 'OPEN' && !!expiresAt && expiresAt.getTime() <= now.getTime();
}
