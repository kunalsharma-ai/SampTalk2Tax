import { dec, type Dec } from './money';
import { loanDueDate } from './loans';

/**
 * Term deposits (fixed deposits) and the interest they earn (BANK-011, TRS-012).
 *
 * Interest compounds at the end of each full compounding period counted from the start date
 * (quarterly for most Indian bank FDs), and the part period after the last full one earns simple
 * interest on the compounded balance, by days on a 365-day year. SIMPLE pays interest on the
 * principal only. Nothing is rounded until the end, so accruals add up to the maturity interest.
 */
export type DepositCompounding = 'SIMPLE' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY';

export const COMPOUNDING_MONTHS: Readonly<Record<Exclude<DepositCompounding, 'SIMPLE'>, number>> = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const daysBetween = (a: string, b: string) => Math.round(day(b) - day(a));

export interface DepositTerms {
  principal: string | Dec;
  /** Percent a year, such as "7.25". */
  annualRate: string | Dec;
  startDate: string;
  maturityDate: string;
  compounding: DepositCompounding;
}

/** Everything wrong with the terms, in plain words. */
export function checkDepositTerms(t: DepositTerms): string[] {
  const errors: string[] = [];
  const p = (() => {
    try {
      return dec(t.principal);
    } catch {
      return null;
    }
  })();
  const r = (() => {
    try {
      return dec(t.annualRate);
    } catch {
      return null;
    }
  })();
  if (!p || !p.gt(0)) errors.push('The amount deposited must be more than zero');
  if (!r || r.lt(0) || r.gt(50)) errors.push('The interest rate must be between 0 and 50 percent a year');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(t.maturityDate)) errors.push('Give the start and maturity dates');
  else if (t.maturityDate <= t.startDate) errors.push('The maturity date must be after the start date');
  else if (daysBetween(t.startDate, t.maturityDate) > 3660) errors.push('A deposit can run for at most ten years');
  if (!['SIMPLE', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'].includes(t.compounding)) errors.push('Choose how interest compounds');
  return errors;
}

/**
 * Interest earned from the start date to `asOf` (capped at maturity), unrounded. Before the start
 * date it is zero.
 */
export function depositInterestExact(t: DepositTerms, asOf: string): Dec {
  const end = asOf > t.maturityDate ? t.maturityDate : asOf;
  if (end <= t.startDate) return dec('0');
  const principal = dec(t.principal);
  const r = dec(t.annualRate).div(100);
  if (t.compounding === 'SIMPLE') return principal.times(r).times(daysBetween(t.startDate, end)).div(365);
  const months = COMPOUNDING_MONTHS[t.compounding];
  let balance = principal;
  let from = t.startDate;
  for (let k = 1; ; k++) {
    // The k-th period ends on the start date's day, k × months later.
    const next = loanDueDate(t.startDate, 1 + k * months);
    if (next > end) break;
    balance = balance.times(r.times(months).div(12).plus(1));
    from = next;
  }
  balance = balance.plus(balance.times(r).times(daysBetween(from, end)).div(365));
  return balance.minus(principal);
}

/** Interest earned to `asOf`, rounded to the currency's minor units. */
export function depositInterest(t: DepositTerms, asOf: string, scale: number): Dec {
  return depositInterestExact(t, asOf).toDecimalPlaces(scale);
}

/** What the deposit pays at maturity before any tax deducted: principal and interest. */
export function depositMaturityValue(t: DepositTerms, scale: number): { interest: Dec; value: Dec } {
  const interest = depositInterest(t, t.maturityDate, scale);
  return { interest, value: dec(t.principal).plus(interest) };
}

/**
 * The interest to accrue now: earned to `asOf` less what is already accrued. Never negative,
 * so a date before the last accrual adds nothing.
 */
export function interestToAccrue(t: DepositTerms, accrued: string | Dec, asOf: string, scale: number): Dec {
  const due = depositInterest(t, asOf, scale).minus(dec(accrued));
  return due.gt(0) ? due : dec('0');
}

/**
 * Closing a deposit, at maturity or early: the bank credits `received` and deducts `tds`.
 * Interest income for the deposit is received + tds − principal; what was accrued is cleared,
 * and the rest (positive or, after a penalty for breaking early, negative) is income now.
 */
export function depositClosing(principal: string | Dec, accrued: string | Dec, received: string | Dec, tds: string | Dec): { interest: Dec; incomeNow: Dec } {
  const interest = dec(received).plus(dec(tds)).minus(dec(principal));
  return { interest, incomeNow: interest.minus(dec(accrued)) };
}
