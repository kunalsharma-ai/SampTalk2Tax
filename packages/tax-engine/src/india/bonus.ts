import { D, Dec } from '@talk2tax/accounting-engine';

/**
 * Statutory bonus for an accounting year (Code on Wages 2019, Chapter IV, which
 * replaced the Payment of Bonus Act 1965 from 21 November 2025).
 *
 * - An employee whose monthly wages do not exceed the notified eligibility amount,
 *   and who worked at least 30 days in the year, gets a bonus.
 * - Bonus is worked out on wages earned, but a month's wages above the
 *   calculation ceiling count as the ceiling (or the state minimum wage, if higher:
 *   enter that as the ceiling).
 * - The rate is at least 8.33% and at most 20%. The minimum bonus is Rs 100.
 *
 * The two amounts are inputs because they are set by notification. The defaults
 * are the Payment of Bonus Act figures (Rs 21,000 and Rs 7,000), carried over
 * until the appropriate government notifies its own: check them before paying.
 *
 * Not modelled: allocable surplus and set-on/set-off (the employer chooses the rate),
 * disqualification for misconduct (leave the employee out), the Rs 60 minimum for
 * employees under 15, and new establishments' first five years.
 */
export const BONUS_RULES = {
  eligibilityCeiling: '21000',
  calculationCeiling: '7000',
  minRate: '8.33',
  maxRate: '20',
  minAmount: '100',
  minDays: 30,
  source: 'Code on Wages 2019 ss.26-27; amounts as under the Payment of Bonus Act 1965 ss.2(13), 10, 12 and 31A until notified',
} as const;

export interface BonusMonth {
  /** YYYY-MM */
  period: string;
  /** Wages earned in the month (basic, dearness allowance and other pay counted as wages). */
  wages: Dec;
  /** Days worked or paid in the month. */
  paidDays: Dec;
  /** Wages for a full month, which decide eligibility (so a month with unpaid leave does not make someone eligible). Defaults to `wages`. */
  fullMonthWages?: Dec;
}

export interface BonusOptions {
  ratePct: string;
  eligibilityCeiling?: string;
  calculationCeiling?: string;
}

export interface BonusMonthResult {
  period: string;
  wages: string;
  /** Wages counted for bonus: the wages, capped at the calculation ceiling; 0 when the month's wages are over the eligibility amount. */
  bonusWages: string;
  eligible: boolean;
}

export interface BonusResult {
  eligible: boolean;
  /** Why the employee gets no bonus, when not eligible. */
  reason: string | null;
  daysWorked: string;
  bonusWages: string;
  /** Rate × bonus wages, before the Rs 100 minimum. */
  atRate: string;
  bonus: string;
  months: BonusMonthResult[];
}

export class BonusRuleError extends Error {}

/** The accounting year (April to March) a label like 2025-26 covers, as its first and last months. */
export function bonusYearMonths(year: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(year);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new BonusRuleError('The year looks like 2025-26');
  const y = Number(m[1]);
  return Array.from({ length: 12 }, (_, i) => (i < 9 ? `${y}-${String(i + 4).padStart(2, '0')}` : `${y + 1}-${String(i - 8).padStart(2, '0')}`));
}

export function checkBonusOptions(o: BonusOptions) {
  const rate = new D(o.ratePct);
  if (!rate.isFinite() || rate.lt(BONUS_RULES.minRate) || rate.gt(BONUS_RULES.maxRate)) throw new BonusRuleError(`The bonus rate is from ${BONUS_RULES.minRate}% to ${BONUS_RULES.maxRate}%`);
  for (const [k, v] of [['eligibility amount', o.eligibilityCeiling], ['calculation ceiling', o.calculationCeiling]] as const) {
    if (v !== undefined && (!new D(v).isFinite() || new D(v).lte(0))) throw new BonusRuleError(`The ${k} must be more than zero`);
  }
}

/** Bonus for one employee from the months they were paid in the year. */
export function statutoryBonus(months: BonusMonth[], o: BonusOptions): BonusResult {
  checkBonusOptions(o);
  const eligibility = new D(o.eligibilityCeiling ?? BONUS_RULES.eligibilityCeiling);
  const ceiling = new D(o.calculationCeiling ?? BONUS_RULES.calculationCeiling);
  let days = new D(0);
  let base = new D(0);
  const rows: BonusMonthResult[] = [...months]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((m) => {
      days = days.plus(m.paidDays);
      const ok = (m.fullMonthWages ?? m.wages).lte(eligibility);
      const counted = ok ? D.min(m.wages, ceiling) : new D(0);
      base = base.plus(counted);
      return { period: m.period, wages: m.wages.toFixed(2), bonusWages: counted.toFixed(2), eligible: ok };
    });
  const atRate = base.times(o.ratePct).div(100).toDecimalPlaces(2, D.ROUND_HALF_UP);
  const out = { daysWorked: days.toFixed(1).replace(/\.0$/, ''), bonusWages: base.toFixed(2), atRate: atRate.toFixed(2), months: rows };
  if (!rows.length) return { ...out, eligible: false, reason: 'Not paid in the year', bonus: '0.00' };
  if (days.lt(BONUS_RULES.minDays)) return { ...out, eligible: false, reason: `Worked fewer than ${BONUS_RULES.minDays} days in the year`, bonus: '0.00' };
  if (base.isZero()) return { ...out, eligible: false, reason: `Wages were above ${eligibility.toFixed(0)} a month all year`, bonus: '0.00' };
  return { ...out, eligible: true, reason: null, bonus: D.max(atRate, BONUS_RULES.minAmount).toFixed(2) };
}
