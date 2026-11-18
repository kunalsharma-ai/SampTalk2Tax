import { Dec, dec, minorUnits, roundToCurrency } from './money';

/**
 * Expense policy (Directive Part 13, EXP-013 spending limits, EXP-015 policy enforcement,
 * EXP-022 violation detection). The organisation sets rules; a claim is checked against them
 * when it is saved, shown, submitted and approved. A BLOCK rule stops submission; a WARN rule
 * lets the claim through but the approver must say why they approve it anyway.
 *
 * Limits per day and per month count the claimant's other live claims too (submitted,
 * approved or reimbursed), so splitting spending across claims does not get around them.
 */

export type ExpensePolicyKind = 'LINE_MAX' | 'DAILY_MAX' | 'MONTHLY_MAX' | 'CLAIM_MAX' | 'RECEIPT_ABOVE' | 'MAX_AGE_DAYS';
export type PolicySeverity = 'WARN' | 'BLOCK';

export const POLICY_KINDS: readonly ExpensePolicyKind[] = ['LINE_MAX', 'DAILY_MAX', 'MONTHLY_MAX', 'CLAIM_MAX', 'RECEIPT_ABOVE', 'MAX_AGE_DAYS'];
/** Rules that can be narrowed to one expense category. */
export const POLICY_KINDS_WITH_CATEGORY: readonly ExpensePolicyKind[] = ['LINE_MAX', 'DAILY_MAX', 'MONTHLY_MAX'];

export interface ExpensePolicyRule {
  id: string;
  kind: ExpensePolicyKind;
  severity: PolicySeverity;
  /** LINE_MAX, DAILY_MAX, MONTHLY_MAX: one expense account, or null for every category. */
  accountId: string | null;
  /** How the category reads in messages, such as "6600 · Meals". */
  accountLabel?: string | null;
  /** A limit or threshold in the organisation's currency (all kinds but MAX_AGE_DAYS). */
  amount: string | null;
  /** MAX_AGE_DAYS: how old a receipt may be when the claim is submitted. */
  days: number | null;
}

export interface PolicyClaimLine {
  lineNo: number;
  date: string;
  accountId: string;
  amount: string;
  /** Mileage and per diem lines have no receipt to attach. */
  isAllowance?: boolean;
}

export interface PolicyOtherLine {
  date: string;
  accountId: string;
  amount: string;
}

export interface PolicyViolation {
  ruleId: string;
  kind: ExpensePolicyKind;
  severity: PolicySeverity;
  /** The claim line it is about, or null when it is about the claim as a whole. */
  lineNo: number | null;
  message: string;
}

/** Problems with a rule as the organisation sets it, or an empty list. */
export function expensePolicyRuleIssues(r: Omit<ExpensePolicyRule, 'id'>, currency: string): string[] {
  const issues: string[] = [];
  if (!POLICY_KINDS.includes(r.kind)) return ['Choose what the rule checks'];
  if (r.severity !== 'WARN' && r.severity !== 'BLOCK') issues.push('Choose whether the rule warns or blocks');
  if (r.accountId && !POLICY_KINDS_WITH_CATEGORY.includes(r.kind)) issues.push('Only limits per receipt, per day and per month can be narrowed to one category');
  if (r.kind === 'MAX_AGE_DAYS') {
    if (r.amount != null) issues.push('A receipt age rule takes days, not an amount');
    if (!Number.isInteger(r.days) || r.days! < 1 || r.days! > 3650) issues.push('Give the number of days, from 1 to 3650');
    return issues;
  }
  if (r.days != null) issues.push('Only a receipt age rule takes days');
  let amount: Dec | null = null;
  try {
    amount = r.amount == null ? null : dec(r.amount);
  } catch {
    amount = null;
  }
  if (!amount) issues.push('The limit must be a decimal amount');
  else {
    if (r.kind === 'RECEIPT_ABOVE' ? amount.lt(0) : !amount.gt(0)) issues.push(r.kind === 'RECEIPT_ABOVE' ? 'The amount cannot be negative' : 'The limit must be above zero');
    if (!roundToCurrency(amount, currency).eq(amount)) issues.push(`The amount has more decimal places than ${currency} allows`);
  }
  return issues;
}

/** What a rule says, in a line, for lists and messages. */
export function describeExpensePolicyRule(r: ExpensePolicyRule, currency: string): string {
  const cat = r.accountId ? ` for ${r.accountLabel ?? 'one category'}` : '';
  const amt = r.amount != null ? money(dec(r.amount), currency) : '';
  switch (r.kind) {
    case 'LINE_MAX':
      return `At most ${amt} per receipt${cat}`;
    case 'DAILY_MAX':
      return `At most ${amt} a day${cat}`;
    case 'MONTHLY_MAX':
      return `At most ${amt} a calendar month${cat}`;
    case 'CLAIM_MAX':
      return `At most ${amt} in one claim`;
    case 'RECEIPT_ABOVE':
      return `Receipts attached for any receipt line over ${amt}`;
    case 'MAX_AGE_DAYS':
      return `Receipts no older than ${r.days} ${r.days === 1 ? 'day' : 'days'} when submitted`;
  }
}

function money(x: Dec, currency: string) {
  return `${currency} ${roundToCurrency(x, currency).toFixed(minorUnits(currency))}`;
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Every rule this claim breaks. `others` are the claimant's lines on their other live claims;
 * `asOf` is the day it is checked (submission day for receipt age).
 */
export function checkExpensePolicy(
  rules: ExpensePolicyRule[],
  claim: { lines: PolicyClaimLine[]; receiptCount: number; asOf: string },
  others: PolicyOtherLine[],
  currency: string,
): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const total = claim.lines.reduce((s, l) => s.plus(l.amount), dec('0'));
  const fmt = (x: Dec) => money(x, currency);
  for (const r of rules) {
    const inScope = (accountId: string) => !r.accountId || r.accountId === accountId;
    const cat = r.accountId ? ` for ${r.accountLabel ?? 'this category'}` : '';
    const v = (lineNo: number | null, message: string) => out.push({ ruleId: r.id, kind: r.kind, severity: r.severity, lineNo, message });
    const limit = r.amount != null ? dec(r.amount) : dec('0');
    switch (r.kind) {
      case 'LINE_MAX':
        for (const l of claim.lines) if (inScope(l.accountId) && dec(l.amount).gt(limit)) v(l.lineNo, `Line ${l.lineNo}: ${fmt(dec(l.amount))} is over the limit of ${fmt(limit)} per receipt${cat}`);
        break;
      case 'DAILY_MAX':
      case 'MONTHLY_MAX': {
        const key = (date: string) => (r.kind === 'DAILY_MAX' ? date : date.slice(0, 7));
        const mine = new Map<string, Dec>();
        for (const l of claim.lines) if (inScope(l.accountId)) mine.set(key(l.date), (mine.get(key(l.date)) ?? dec('0')).plus(l.amount));
        for (const [k, own] of [...mine].sort(([a], [b]) => a.localeCompare(b))) {
          const elsewhere = others.filter((o) => inScope(o.accountId) && key(o.date) === k).reduce((s, o) => s.plus(o.amount), dec('0'));
          const sum = own.plus(elsewhere);
          if (!sum.gt(limit)) continue;
          const when = r.kind === 'DAILY_MAX' ? `On ${k}` : `In ${k}`;
          const other = elsewhere.gt(0) ? ` (${fmt(elsewhere)} of it on your other claims)` : '';
          v(null, `${when}, ${fmt(sum)} is claimed${cat}${other}, over the limit of ${fmt(limit)} ${r.kind === 'DAILY_MAX' ? 'a day' : 'a month'}`);
        }
        break;
      }
      case 'CLAIM_MAX':
        if (total.gt(limit)) v(null, `The claim totals ${fmt(total)}, over the limit of ${fmt(limit)} for one claim`);
        break;
      case 'RECEIPT_ABOVE': {
        if (claim.receiptCount > 0) break;
        const over = claim.lines.filter((l) => !l.isAllowance && dec(l.amount).gt(limit)).map((l) => l.lineNo);
        if (over.length) v(null, `Attach the receipts: ${over.length === 1 ? 'line' : 'lines'} ${over.join(', ')} ${over.length === 1 ? 'is' : 'are'} over ${fmt(limit)} and the claim has no receipt attached`);
        break;
      }
      case 'MAX_AGE_DAYS':
        for (const l of claim.lines) {
          const age = daysBetween(l.date, claim.asOf);
          if (age > r.days!) v(l.lineNo, `Line ${l.lineNo}: the receipt is ${age} days old; claims must be made within ${r.days} days`);
        }
        break;
    }
  }
  return out;
}
