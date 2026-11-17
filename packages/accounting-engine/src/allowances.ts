import { Dec, MoneyError, dec, roundToCurrency } from './money';

/**
 * Mileage and per diem claims (Directive Part 13, EXP-006 and EXP-008). Instead of a receipt,
 * the employee claims a distance driven for work or days away from base, at a rate the
 * organisation sets. The amount is quantity × rate, rounded to the currency (half-even, as
 * every other amount). No tax is split out: an allowance is not a supply with tax on it.
 */

export type AllowanceKind = 'MILEAGE' | 'PER_DIEM';

export const ALLOWANCE_UNIT: Record<AllowanceKind, 'KM' | 'DAY'> = { MILEAGE: 'KM', PER_DIEM: 'DAY' };
/** The most one line can claim: a long road trip, or a month away. */
export const MAX_KM_PER_LINE = '5000';
export const MAX_DAYS_PER_LINE = '31';

export interface AllowanceRateInput {
  kind: AllowanceKind;
  name: string;
  /** Per kilometre or per day, as a decimal string. */
  rate: string;
}

/** Problems with a rate as the organisation sets it, or an empty list. */
export function allowanceRateIssues(r: AllowanceRateInput, currency: string): string[] {
  const issues: string[] = [];
  const name = r.name.trim();
  if (name.length < 1 || name.length > 80) issues.push('Give the rate a name of 1 to 80 characters, such as "Car" or "Metro city"');
  let rate: Dec | null = null;
  try {
    rate = dec(r.rate);
  } catch {
    issues.push('The rate must be a decimal amount');
  }
  if (rate) {
    if (!rate.gt(0)) issues.push('The rate must be above zero');
    // Mileage rates go below the currency's minor unit (₹9.50, £0.45, $0.725 a mile): up to 4 places.
    if (rate.decimalPlaces() > 4) issues.push('The rate can have at most 4 decimal places');
    if (r.kind === 'PER_DIEM' && rate.decimalPlaces() > minorDigits(currency)) issues.push(`A daily rate has at most ${minorDigits(currency)} decimal places in ${currency}`);
  }
  return issues;
}

function minorDigits(currency: string): number {
  return roundToCurrency(dec('0.123456789'), currency).decimalPlaces();
}

export interface AllowanceLineInput {
  kind: AllowanceKind;
  rateName: string;
  rate: string;
  /** Kilometres (to 0.1) or days (whole or half). */
  quantity: string;
  /** Mileage: where the trip started and ended. Per diem: where the person stayed (`to`). */
  from?: string | null;
  to?: string | null;
  purpose?: string | null;
}

export interface ComputedAllowance {
  amount: Dec;
  quantity: Dec;
  rate: Dec;
  /** The line's description, written out so the claim reads on its own. */
  description: string;
}

/** The amount of one mileage or per diem line, or throws MoneyError with what is wrong. */
export function computeAllowance(input: AllowanceLineInput, currency: string): ComputedAllowance {
  let quantity: Dec;
  try {
    quantity = dec(input.quantity);
  } catch {
    throw new MoneyError(input.kind === 'MILEAGE' ? 'Enter the distance in kilometres' : 'Enter the number of days');
  }
  const rate = dec(input.rate);
  if (input.kind === 'MILEAGE') {
    if (!quantity.gt(0) || quantity.gt(MAX_KM_PER_LINE)) throw new MoneyError(`The distance must be above 0 and at most ${MAX_KM_PER_LINE} km on one line`);
    if (quantity.decimalPlaces() > 1) throw new MoneyError('Give the distance to one decimal place (0.1 km)');
    if (!input.from?.trim() || !input.to?.trim()) throw new MoneyError('Say where the trip started and where it ended');
  } else {
    if (!quantity.gt(0) || quantity.gt(MAX_DAYS_PER_LINE)) throw new MoneyError(`The days must be above 0 and at most ${MAX_DAYS_PER_LINE} on one line`);
    if (!quantity.mul(2).isInteger()) throw new MoneyError('Claim whole or half days');
    if (!input.to?.trim()) throw new MoneyError('Say where you stayed');
  }
  const amount = roundToCurrency(quantity.mul(rate), currency);
  if (!amount.gt(0)) throw new MoneyError('The amount comes to zero');
  const purpose = input.purpose?.trim() ? `: ${input.purpose.trim()}` : '';
  const description =
    input.kind === 'MILEAGE'
      ? `Mileage ${quantity.toFixed()} km × ${input.rate.trim()} (${input.rateName.trim()}), ${input.from!.trim()} to ${input.to!.trim()}${purpose}`
      : `Per diem ${quantity.toFixed()} day${quantity.eq(1) ? '' : 's'} × ${input.rate.trim()} (${input.rateName.trim()}), ${input.to!.trim()}${purpose}`;
  return { amount, quantity, rate, description: description.slice(0, 500) };
}
