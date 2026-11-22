/**
 * Unusual expenses and fraud risk indicators (EXP-023, EXP-024): warning signs on the expense
 * claims submitted in a period, across claims and people, and a view of who has the most of them.
 * Deterministic and explainable: each indicator says what it was raised on, no model is used, and
 * amounts are decimal strings. Nothing here blocks or changes a claim; the per-claim checks of
 * EXP-022 (`expenseAnomalies`) are reused and compared with the organisation's approved claims.
 *
 * Indicators, most serious first (draft, rejected and void claims are left out):
 * - HIGH: DUPLICATE_RECEIPT, a receipt line with the same date and amount as a line on another
 *   claim, at the same merchant (or in the same category when a merchant is missing): claimed
 *   twice, by the same person or by two; SPLIT_UNDER_LIMIT, receipts on one day and category each
 *   under a per-receipt limit that together go over it.
 * - MEDIUM: UNUSUAL_AMOUNT, far above the usual for the category; JUST_UNDER_LIMIT, within 5% under
 *   a per-receipt limit; REPEATED_JUST_UNDER, the claimant's third or later line just under a
 *   limit in 90 days; LATE_RECEIPT, a receipt dated more than 60 days before the claim was
 *   submitted; NO_RECEIPTS, receipts of 5,000 or more (by default) with no file attached.
 * - LOW: SUNDAY, a receipt dated on a Sunday; ROUND_AMOUNT, a receipt of 1,000 or more in whole
 *   hundreds.
 */
import { addDays, daysBetween } from './documents';
import { expenseAnomalies, JUST_UNDER_SHARE, type LineLimit } from './expense-anomalies';
import { D, minorUnits } from './money';
import { formatDateText } from './workflows';

export const EXPENSE_RISK_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ExpenseRiskLevel = (typeof EXPENSE_RISK_LEVELS)[number];
export const EXPENSE_RISK_INDICATORS = ['DUPLICATE_RECEIPT', 'SPLIT_UNDER_LIMIT', 'UNUSUAL_AMOUNT', 'JUST_UNDER_LIMIT', 'REPEATED_JUST_UNDER', 'LATE_RECEIPT', 'NO_RECEIPTS', 'SUNDAY', 'ROUND_AMOUNT'] as const;
export type ExpenseRiskCode = (typeof EXPENSE_RISK_INDICATORS)[number];
export const EXPENSE_RISK_LEVEL: Record<ExpenseRiskCode, ExpenseRiskLevel> = {
  DUPLICATE_RECEIPT: 'HIGH',
  SPLIT_UNDER_LIMIT: 'HIGH',
  UNUSUAL_AMOUNT: 'MEDIUM',
  JUST_UNDER_LIMIT: 'MEDIUM',
  REPEATED_JUST_UNDER: 'MEDIUM',
  LATE_RECEIPT: 'MEDIUM',
  NO_RECEIPTS: 'MEDIUM',
  SUNDAY: 'LOW',
  ROUND_AMOUNT: 'LOW',
};
export const EXPENSE_RISK_LABEL: Record<ExpenseRiskCode, string> = {
  DUPLICATE_RECEIPT: 'Possible duplicate receipt',
  SPLIT_UNDER_LIMIT: 'Split around a limit',
  UNUSUAL_AMOUNT: 'Unusually large',
  JUST_UNDER_LIMIT: 'Just under a limit',
  REPEATED_JUST_UNDER: 'Often just under a limit',
  LATE_RECEIPT: 'Old receipt',
  NO_RECEIPTS: 'No receipts attached',
  SUNDAY: 'Spent on a Sunday',
  ROUND_AMOUNT: 'Round amount',
};
const WEIGHT: Record<ExpenseRiskLevel, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const ORDER: Record<ExpenseRiskLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export const EXPENSE_RISK_LATE_DAYS = 60;
export const EXPENSE_RISK_REPEAT_DAYS = 90;
export const EXPENSE_RISK_REPEAT_COUNT = 3;
export const EXPENSE_RISK_RECEIPTS_FROM = '5000';
export const EXPENSE_RISK_ROUND_FROM = '1000';
export const EXPENSE_RISK_HISTORY_DAYS = 365;

/** Claims that count: submitted and not rejected or voided. */
export const EXPENSE_RISK_STATUSES = ['SUBMITTED', 'APPROVED', 'REIMBURSED'] as const;

export interface ExpenseRiskLine {
  lineNo: number;
  date: string;
  accountId: string;
  /** "6600 · Meals", for messages. */
  accountLabel: string;
  merchant: string | null;
  amount: string;
  /** Mileage and per diem lines are worked out from rates, not receipts. */
  isAllowance?: boolean;
}

export interface ExpenseRiskClaim {
  id: string;
  number: string;
  claimantId: string;
  claimantName: string;
  status: string;
  /** Date the claim was submitted. */
  submittedOn: string;
  currency: string;
  total: string;
  /** Files attached to the claim. */
  receiptCount: number;
  lines: ExpenseRiskLine[];
}

export interface ExpenseRiskIndicator {
  code: ExpenseRiskCode;
  level: ExpenseRiskLevel;
  label: string;
  detail: string;
  /** The lines it is about. */
  lineNos: number[];
  /** Another claim it was found with, for duplicates. */
  otherClaim: { id: string; number: string; claimantName: string } | null;
}

export interface ExpenseRiskFinding {
  claim: Omit<ExpenseRiskClaim, 'lines'>;
  level: ExpenseRiskLevel;
  /** 3 for each high indicator, 2 for each medium and 1 for each low. */
  score: number;
  indicators: ExpenseRiskIndicator[];
}

export interface ExpenseRiskPerson {
  claimantId: string;
  claimantName: string;
  claims: number;
  flagged: number;
  high: number;
  medium: number;
  low: number;
  score: number;
  /** Flagged claims' totals, by currency. */
  flaggedTotal: { currency: string; amount: string }[];
  codes: ExpenseRiskCode[];
}

/** A merchant with case, punctuation and spacing taken away, for comparing receipts. */
export function normaliseMerchant(text: string | null): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isSunday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 0; // not money

/**
 * Claims submitted between `from` and `asOf` with at least one indicator, most serious first, and
 * the people who made them. `claims` should also hold the year before, to compare with. `money`
 * formats an amount in a currency for the details.
 */
export function expenseRisk(
  claims: ExpenseRiskClaim[],
  opts: { from: string; asOf: string; limits: LineLimit[]; receiptsFrom?: string; money: (amount: string, currency: string) => string },
): { findings: ExpenseRiskFinding[]; people: ExpenseRiskPerson[] } {
  const counted = claims.filter((c) => (EXPENSE_RISK_STATUSES as readonly string[]).includes(c.status) && c.submittedOn <= opts.asOf);
  const inPeriod = counted.filter((c) => c.submittedOn >= opts.from).sort((a, b) => a.submittedOn.localeCompare(b.submittedOn) || a.number.localeCompare(b.number));
  const receiptsFrom = new D(opts.receiptsFrom ?? EXPENSE_RISK_RECEIPTS_FROM);
  const roundFrom = new D(EXPENSE_RISK_ROUND_FROM);
  const findings: ExpenseRiskFinding[] = [];

  // The tightest per-receipt limit for a category, for lines just under one.
  const limitFor = (accountId: string) =>
    opts.limits
      .filter((r) => !r.accountId || r.accountId === accountId)
      .map((r) => new D(r.amount))
      .sort((a, b) => a.comparedTo(b))[0] ?? null;
  const justUnder = (l: ExpenseRiskLine) => {
    const limit = limitFor(l.accountId);
    const x = new D(l.amount);
    return !l.isAllowance && !!limit && x.lte(limit) && x.gte(limit.times(JUST_UNDER_SHARE));
  };

  for (const c of inPeriod) {
    const indicators: ExpenseRiskIndicator[] = [];
    const add = (code: ExpenseRiskCode, detail: string, lineNos: number[], otherClaim: ExpenseRiskIndicator['otherClaim'] = null) =>
      indicators.push({ code, level: EXPENSE_RISK_LEVEL[code], label: EXPENSE_RISK_LABEL[code], detail, lineNos, otherClaim });
    const receipts = c.lines.filter((l) => !l.isAllowance);
    const fmt = (x: InstanceType<typeof D> | string) => opts.money(new D(x).toFixed(), c.currency);

    // The same receipt on another claim.
    for (const l of receipts) {
      const m = normaliseMerchant(l.merchant);
      for (const o of counted) {
        if (o.id === c.id || o.currency !== c.currency) continue;
        const twin = o.lines.find((x) => !x.isAllowance && x.date === l.date && new D(x.amount).eq(l.amount) && (m && normaliseMerchant(x.merchant) ? normaliseMerchant(x.merchant) === m : x.accountId === l.accountId));
        if (!twin) continue;
        const who = o.claimantId === c.claimantId ? 'the same person' : o.claimantName;
        add('DUPLICATE_RECEIPT', `Line ${l.lineNo}: ${fmt(l.amount)} on ${formatDateText(l.date)}${l.merchant ? ` at ${l.merchant}` : ` for ${l.accountLabel}`} is also line ${twin.lineNo} of ${o.number}, claimed by ${who}`, [l.lineNo], { id: o.id, number: o.number, claimantName: o.claimantName });
        break;
      }
    }

    // EXP-022 checks against the organisation's approved claims of the year before.
    const history = new Map<string, string[]>();
    const since = addDays(c.submittedOn, -EXPENSE_RISK_HISTORY_DAYS);
    for (const o of counted) {
      if (o.id === c.id || o.currency !== c.currency || (o.status !== 'APPROVED' && o.status !== 'REIMBURSED')) continue;
      for (const x of o.lines) if (!x.isAllowance && x.date >= since && x.date <= c.submittedOn) history.set(x.accountId, [...(history.get(x.accountId) ?? []), x.amount]);
    }
    for (const a of expenseAnomalies(
      c.lines.map((l) => ({ lineNo: l.lineNo, date: l.date, accountId: l.accountId, accountLabel: l.accountLabel, amount: l.amount, isAllowance: l.isAllowance })),
      history,
      opts.limits,
      c.currency,
    ))
      add(a.code, a.message, a.lineNos);

    // The claimant keeps landing just under a limit.
    const under = c.lines.filter(justUnder);
    if (under.length) {
      const start = addDays(c.submittedOn, -EXPENSE_RISK_REPEAT_DAYS);
      const mine = counted.filter((o) => o.claimantId === c.claimantId && o.submittedOn >= start && o.submittedOn <= c.submittedOn);
      const count = mine.reduce((n, o) => n + o.lines.filter(justUnder).length, 0);
      if (count >= EXPENSE_RISK_REPEAT_COUNT) add('REPEATED_JUST_UNDER', `${plural(count, 'line')} just under a per-receipt limit on ${c.claimantName}'s claims in the ${EXPENSE_RISK_REPEAT_DAYS} days to ${formatDateText(c.submittedOn)}`, under.map((l) => l.lineNo));
    }

    const late = receipts.filter((l) => daysBetween(l.date, c.submittedOn) > EXPENSE_RISK_LATE_DAYS);
    if (late.length) {
      const oldest = late.reduce((m, l) => (l.date < m.date ? l : m), late[0]!);
      add('LATE_RECEIPT', `${late.length === 1 ? `Line ${oldest.lineNo} is` : `${plural(late.length, 'line')} are`} dated more than ${EXPENSE_RISK_LATE_DAYS} days before the claim was submitted (the oldest ${daysBetween(oldest.date, c.submittedOn)} days)`, late.map((l) => l.lineNo));
    }

    const receiptTotal = receipts.reduce((s, l) => s.plus(l.amount), new D(0));
    if (c.receiptCount === 0 && receiptTotal.gte(receiptsFrom)) add('NO_RECEIPTS', `${fmt(receiptTotal)} of receipts claimed with no file attached`, receipts.map((l) => l.lineNo));

    const sundays = receipts.filter((l) => isSunday(l.date));
    if (sundays.length) add('SUNDAY', `${sundays.length === 1 ? `Line ${sundays[0]!.lineNo} is` : `Lines ${sundays.map((l) => l.lineNo).join(', ')} are`} dated on a Sunday`, sundays.map((l) => l.lineNo));

    const round = receipts.filter((l) => new D(l.amount).gte(roundFrom) && new D(l.amount).mod(100).isZero());
    if (round.length) add('ROUND_AMOUNT', `${round.length === 1 ? `Line ${round[0]!.lineNo} is` : `Lines ${round.map((l) => l.lineNo).join(', ')} are`} a round amount (${round.map((l) => fmt(l.amount)).join(', ')}), unusual for a real bill`, round.map((l) => l.lineNo));

    if (!indicators.length) continue;
    indicators.sort((a, b) => ORDER[a.level] - ORDER[b.level] || EXPENSE_RISK_INDICATORS.indexOf(a.code) - EXPENSE_RISK_INDICATORS.indexOf(b.code) || a.lineNos[0]! - b.lineNos[0]!);
    const { lines: _lines, ...claim } = c;
    findings.push({ claim, level: indicators[0]!.level, score: indicators.reduce((s, i) => s + WEIGHT[i.level], 0), indicators });
  }
  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level] || b.score - a.score || b.claim.submittedOn.localeCompare(a.claim.submittedOn) || a.claim.number.localeCompare(b.claim.number));

  const people = new Map<string, ExpenseRiskPerson>();
  for (const c of inPeriod) {
    const p = people.get(c.claimantId) ?? { claimantId: c.claimantId, claimantName: c.claimantName, claims: 0, flagged: 0, high: 0, medium: 0, low: 0, score: 0, flaggedTotal: [], codes: [] };
    p.claims++;
    people.set(c.claimantId, p);
  }
  for (const f of findings) {
    const p = people.get(f.claim.claimantId)!;
    p.flagged++;
    p.score += f.score;
    for (const i of f.indicators) {
      if (i.level === 'HIGH') p.high++;
      else if (i.level === 'MEDIUM') p.medium++;
      else p.low++;
      if (!p.codes.includes(i.code)) p.codes.push(i.code);
    }
    const t = p.flaggedTotal.find((x) => x.currency === f.claim.currency);
    if (t) t.amount = new D(t.amount).plus(f.claim.total).toFixed(minorUnits(t.currency));
    else p.flaggedTotal.push({ currency: f.claim.currency, amount: new D(f.claim.total).toFixed(minorUnits(f.claim.currency)) });
  }
  const list = [...people.values()].filter((p) => p.flagged);
  for (const p of list) p.codes.sort((a, b) => EXPENSE_RISK_INDICATORS.indexOf(a) - EXPENSE_RISK_INDICATORS.indexOf(b));
  return { findings, people: list.sort((a, b) => b.score - a.score || b.high - a.high || a.claimantName.localeCompare(b.claimantName)) };
}
