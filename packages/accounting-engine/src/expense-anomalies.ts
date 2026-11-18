import { D, Dec, dec, minorUnits, roundToCurrency } from './money';

/**
 * Expense anomaly checks (EXP-022): signs worth an approver's second look that no single policy
 * rule catches. They never block a claim; they are shown next to it with the reason.
 *
 * - UNUSUAL_AMOUNT: a line far above what the organisation usually pays for that category. The
 *   usual is the median of approved and reimbursed lines in the last 12 months (at least
 *   MIN_HISTORY of them); a line is unusual at more than 3 times the median and, where amounts
 *   vary, a robust z-score (median absolute deviation) above 3.5.
 * - JUST_UNDER_LIMIT: a line within 5% below a per-receipt limit, a common way to avoid it.
 * - SPLIT_UNDER_LIMIT: two or more lines on the same day and category, each within the
 *   per-receipt limit, that together go over it: one bill split to stay under the limit.
 */
export type ExpenseAnomalyCode = 'UNUSUAL_AMOUNT' | 'JUST_UNDER_LIMIT' | 'SPLIT_UNDER_LIMIT';

export interface ExpenseAnomaly {
  code: ExpenseAnomalyCode;
  /** The line it is about; the first line of a split. */
  lineNo: number;
  lineNos: number[];
  message: string;
}

export interface AnomalyLine {
  lineNo: number;
  date: string;
  accountId: string;
  /** "6600 · Meals", for messages. */
  accountLabel: string;
  amount: string;
  /** Mileage and per diem lines are worked out from rates, not receipts. */
  isAllowance?: boolean;
}

export interface LineLimit {
  /** One category, or null for every category. */
  accountId: string | null;
  amount: string;
}

export const MIN_HISTORY = 8;
export const UNUSUAL_MULTIPLE = 3;
export const UNUSUAL_Z = 3.5;
export const JUST_UNDER_SHARE = '0.95';

export function median(xs: Dec[]): Dec {
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : s[m - 1]!.plus(s[m]!).div(2);
}

/**
 * Robust z-score of `x` against `xs`: 0.6745 × (x − median) ÷ MAD. Null when the amounts do not
 * vary (MAD is zero), so the multiple of the median decides alone.
 */
export function robustZ(x: Dec, xs: Dec[]): number | null {
  const m = median(xs);
  const mad = median(xs.map((v) => v.minus(m).abs()));
  if (mad.isZero()) return null;
  return x.minus(m).times('0.6745').div(mad).toNumber();
}

export function expenseAnomalies(lines: AnomalyLine[], history: Map<string, string[]>, limits: LineLimit[], currency: string): ExpenseAnomaly[] {
  const fmt = (x: Dec) => `${currency} ${roundToCurrency(x, currency).toFixed(minorUnits(currency))}`;
  const out: ExpenseAnomaly[] = [];
  const receipts = lines.filter((l) => !l.isAllowance);
  // The tightest per-receipt limit that applies to a category.
  const limitFor = (accountId: string) =>
    limits
      .filter((r) => !r.accountId || r.accountId === accountId)
      .map((r) => dec(r.amount))
      .sort((a, b) => a.comparedTo(b))[0] ?? null;

  for (const l of receipts) {
    const past = (history.get(l.accountId) ?? []).map((a) => dec(a));
    if (past.length < MIN_HISTORY) continue;
    const x = dec(l.amount);
    const m = median(past);
    if (!m.gt(0) || !x.gt(m.times(UNUSUAL_MULTIPLE))) continue;
    const z = robustZ(x, past);
    if (z !== null && z <= UNUSUAL_Z) continue;
    const times = x.div(m).toDecimalPlaces(0, D.ROUND_HALF_UP).toFixed(0);
    out.push({ code: 'UNUSUAL_AMOUNT', lineNo: l.lineNo, lineNos: [l.lineNo], message: `Line ${l.lineNo}: ${fmt(x)} is about ${times} times the usual for ${l.accountLabel} (median ${fmt(m)} across ${past.length} approved lines in the last 12 months)` });
  }

  for (const l of receipts) {
    const limit = limitFor(l.accountId);
    if (!limit) continue;
    const x = dec(l.amount);
    if (x.lte(limit) && x.gte(limit.times(JUST_UNDER_SHARE))) {
      out.push({ code: 'JUST_UNDER_LIMIT', lineNo: l.lineNo, lineNos: [l.lineNo], message: `Line ${l.lineNo}: ${fmt(x)} is just under the limit of ${fmt(limit)} per receipt for ${l.accountLabel}` });
    }
  }

  const groups = new Map<string, AnomalyLine[]>();
  for (const l of receipts) groups.set(`${l.date}|${l.accountId}`, [...(groups.get(`${l.date}|${l.accountId}`) ?? []), l]);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const limit = limitFor(g[0]!.accountId);
    if (!limit || g.some((l) => dec(l.amount).gt(limit))) continue;
    const sum = g.reduce((s, l) => s.plus(l.amount), dec('0'));
    if (!sum.gt(limit)) continue;
    const nos = g.map((l) => l.lineNo).sort((a, b) => a - b);
    out.push({ code: 'SPLIT_UNDER_LIMIT', lineNo: nos[0]!, lineNos: nos, message: `Lines ${nos.join(', ')}: ${g.length} ${g[0]!.accountLabel} receipts on ${g[0]!.date} total ${fmt(sum)}, over the limit of ${fmt(limit)} per receipt, though each is under it. Check it is not one bill split up` });
  }
  return out.sort((a, b) => a.lineNo - b.lineNo || a.code.localeCompare(b.code));
}
