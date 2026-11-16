import type { AccountType } from './accounts';
import { Dec, dec, minorUnits, roundToCurrency, sum } from './money';

/**
 * Foreign-currency balances and their revaluation at a period end.
 *
 * A balance kept in a foreign currency (a USD bank account, a EUR loan) is carried in the books
 * at the rates of the days its entries were posted. At a period end it is restated at the closing
 * rate: the difference is an unrealised exchange gain or loss. Talk2Tax posts it on the date and
 * reverses it the next day, so the carried amount is always the sum of the entries themselves
 * and each revaluation starts from them.
 *
 * Only monetary balances are revalued (cash, receivables, payables, loans, accruals). Inventory,
 * prepayments, fixed assets and their depreciation stay at historical rates, as do equity,
 * income and expenses.
 */

/** Asset and liability subtypes kept at historical rates. */
export const NON_MONETARY_SUBTYPES: readonly string[] = ['INVENTORY', 'PREPAID', 'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION'];

export function isMonetary(type: AccountType, subtype: string | null | undefined): boolean {
  if (type !== 'ASSET' && type !== 'LIABILITY') return false;
  return !subtype || !NON_MONETARY_SUBTYPES.includes(subtype);
}

export interface ForeignBalance {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  currency: string;
  /** Net debit in the foreign currency (credit balances are negative). */
  foreign: string | Dec;
  /** Net debit carried in the functional currency for those same entries. */
  carried: string | Dec;
}

export interface RevaluationLine {
  accountId: string;
  code: string;
  name: string;
  currency: string;
  foreign: Dec;
  rate: Dec;
  carried: Dec;
  revalued: Dec;
  /** revalued − carried: positive increases the debit balance. */
  adjustment: Dec;
}

export interface RevaluationPlan {
  lines: RevaluationLine[];
  /** Net gain (positive) or loss (negative) in the functional currency. */
  gain: Dec;
  /** Currencies with a balance but no rate. */
  missingRates: string[];
  /** Balances not revalued because the account is not monetary. */
  skipped: { accountId: string; code: string; name: string; currency: string; reason: string }[];
}

export class FxError extends Error {}

/** Checks a rate: functional units per one foreign unit, positive, at most 10 decimals. */
export function checkRate(rate: string): Dec {
  if (!/^\d{1,14}(\.\d{1,10})?$/.test(rate.trim())) throw new FxError('Enter the rate as a number, such as 83.25 (functional currency per one unit).');
  const r = dec(rate.trim());
  if (r.lte(0)) throw new FxError('The rate must be more than zero.');
  return r;
}

/** The latest rate on or before the date, from rates sorted in any order. */
export function rateOn<T extends { date: string; rate: string }>(rates: readonly T[], date: string): T | null {
  let best: T | null = null;
  for (const r of rates) if (r.date <= date && (!best || r.date > best.date)) best = r;
  return best;
}

/**
 * Works out the revaluation of each monetary foreign balance at the given closing rates.
 * Amounts are rounded to the functional currency's minor units (half to even, as everywhere).
 */
export function revaluationPlan(balances: readonly ForeignBalance[], rates: Readonly<Record<string, string>>, functionalCurrency: string): RevaluationPlan {
  const lines: RevaluationLine[] = [];
  const missing = new Set<string>();
  const skipped: RevaluationPlan['skipped'] = [];
  for (const b of balances) {
    if (b.currency === functionalCurrency) continue;
    const foreign = dec(String(b.foreign));
    const carried = dec(String(b.carried));
    if (foreign.isZero() && carried.isZero()) continue;
    if (!isMonetary(b.type, b.subtype)) {
      skipped.push({ accountId: b.accountId, code: b.code, name: b.name, currency: b.currency, reason: 'Not monetary: kept at historical rates' });
      continue;
    }
    const given = rates[b.currency];
    if (given === undefined) {
      missing.add(b.currency);
      continue;
    }
    const rate = checkRate(given);
    const revalued = roundToCurrency(foreign.times(rate), functionalCurrency);
    const adjustment = revalued.minus(carried);
    lines.push({ accountId: b.accountId, code: b.code, name: b.name, currency: b.currency, foreign, rate, carried, revalued, adjustment });
  }
  lines.sort((a, b) => a.code.localeCompare(b.code) || a.currency.localeCompare(b.currency));
  return { lines, gain: sum(lines.map((l) => l.adjustment)), missingRates: [...missing].sort(), skipped };
}

/**
 * The journal for a plan: each balance moves by its adjustment and the difference goes to the
 * exchange gain or loss account, all in the functional currency. Null when nothing changes.
 */
export function revaluationJournal(plan: RevaluationPlan, fxAccountId: string, functionalCurrency: string): { accountId: string; debit?: string; credit?: string; description: string }[] | null {
  const scale = minorUnits(functionalCurrency);
  const moving = plan.lines.filter((l) => !l.adjustment.isZero());
  if (!moving.length) return null;
  const out: { accountId: string; debit?: string; credit?: string; description: string }[] = moving.map((l) => ({
    accountId: l.accountId,
    ...(l.adjustment.isPositive() ? { debit: l.adjustment.toFixed(scale) } : { credit: l.adjustment.negated().toFixed(scale) }),
    description: `${l.currency} ${l.foreign.toFixed()} at ${l.rate.toFixed()}`,
  }));
  if (!plan.gain.isZero()) {
    out.push({ accountId: fxAccountId, ...(plan.gain.isPositive() ? { credit: plan.gain.toFixed(scale) } : { debit: plan.gain.negated().toFixed(scale) }), description: plan.gain.isPositive() ? 'Unrealised exchange gain' : 'Unrealised exchange loss' });
  }
  return out;
}

/** The day after an ISO date. */
export function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
