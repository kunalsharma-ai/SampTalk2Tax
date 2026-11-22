import { addDays, daysBetween } from './documents';
import { D, Dec } from './money';
import { formatAmountText, formatDateText } from './workflows';

/**
 * Expense reconciliation (EXP-016). Three checks on employee expense claims as of a date:
 *
 * - The ledger against the claims: the balance of the Employee Reimbursements Payable account
 *   (credit less debit, up to the date) against the approved claims still owed on that date
 *   (approved on or before it, and neither reimbursed nor voided by then). Every difference is
 *   listed: an entry on the account that no claim made (such as an opening balance), or a claim
 *   whose own entries on the account do not come to what the claim says is owed.
 * - Reimbursements against the bank: each reimbursement of the last 90 days is cleared when its
 *   bank line is matched to a statement line; not on the statement when the bank's imported
 *   statements already run 3 or more days past it; otherwise waiting for the statement.
 * - What is owed, by age since approval and by employee; owed for over 30 days is overdue.
 *
 * Deterministic and read-only: nothing is posted.
 */

export const EXPENSE_RECON_OVERDUE_DAYS = 30;
export const EXPENSE_RECON_REIMBURSED_DAYS = 90;
/** Days a statement must run past a reimbursement before a missing one counts. */
export const EXPENSE_RECON_STATEMENT_GRACE = 3;

export const EXPENSE_RECON_AGES = [
  { key: 'D0_15', label: '0 to 15 days', to: 15 },
  { key: 'D16_30', label: '16 to 30 days', to: 30 },
  { key: 'D31_60', label: '31 to 60 days', to: 60 },
  { key: 'OVER_60', label: 'Over 60 days', to: Infinity },
] as const;

export type ReimbursementBankStatus = 'CLEARED' | 'NOT_ON_STATEMENT' | 'AWAITING_STATEMENT';
export const REIMBURSEMENT_BANK_LABEL: Record<ReimbursementBankStatus, string> = {
  CLEARED: 'Matched on the statement',
  NOT_ON_STATEMENT: 'Not on the statement',
  AWAITING_STATEMENT: 'Statement not imported yet',
};

export interface ExpenseReconClaim {
  id: string;
  number: string;
  claimantId: string;
  claimant: string;
  title: string;
  total: string;
  /** The date the claim was posted (approved). */
  approvedOn: string;
  reimbursedOn: string | null;
  voidDate: string | null;
  /** The claim's own journal entries: approval, reimbursement and void. */
  entryIds: string[];
}

/** A journal line on the payable account. */
export interface ExpenseReconLedgerLine {
  entryId: string;
  entryNumber: number | null;
  date: string;
  memo: string | null;
  source: string;
  /** Credit less debit. */
  net: string;
}

export interface ExpenseReconReimbursement {
  claimId: string;
  number: string;
  claimant: string;
  amount: string;
  date: string;
  bankAccount: string;
  matched: boolean;
  /** The latest statement line date imported for that bank account. */
  statementThrough: string | null;
}

export interface ExpenseReconItem {
  kind: 'NOT_FROM_A_CLAIM' | 'CLAIM_DIFFERS';
  date: string;
  reference: string;
  description: string;
  /** Ledger less claims: positive when the ledger shows more owed. */
  amount: string;
  entryId: string | null;
  claimId: string | null;
}

export interface ExpenseReconciliation {
  asOf: string;
  ledger: string;
  claims: string;
  difference: string;
  reconciled: boolean;
  items: ExpenseReconItem[];
  owed: { id: string; number: string; claimant: string; title: string; amount: string; approvedOn: string; days: number; overdue: boolean }[];
  ages: { key: (typeof EXPENSE_RECON_AGES)[number]['key']; label: string; claims: number; amount: string }[];
  employees: { claimantId: string; claimant: string; claims: number; amount: string; oldestDays: number; overdue: string }[];
  overdue: { claims: number; amount: string };
  reimbursements: (ExpenseReconReimbursement & { status: ReimbursementBankStatus; statusLabel: string; days: number })[];
  bank: { cleared: number; notOnStatement: number; notOnStatementAmount: string; awaiting: number };
}

/** The employee reimbursements account reconciled to the claims, and reimbursements to the bank. */
export function reconcileExpenseClaims(input: { claims: ExpenseReconClaim[]; ledger: ExpenseReconLedgerLine[]; reimbursements: ExpenseReconReimbursement[]; asOf: string; currency: string; scale: number }): ExpenseReconciliation {
  const { asOf, scale } = input;
  const money = (x: Dec) => formatAmountText(x.toFixed(scale), input.currency);
  const lines = input.ledger.filter((l) => l.date <= asOf);
  const by = (d: string | null) => d !== null && d <= asOf;
  const owedOn = (c: ExpenseReconClaim) => (by(c.approvedOn) && !by(c.reimbursedOn) && !by(c.voidDate) ? new D(c.total) : new D(0));

  const claimOf = new Map(input.claims.flatMap((c) => c.entryIds.map((e) => [e, c] as const)));
  const ledger = lines.reduce((s, l) => s.plus(l.net), new D(0));
  const claimsOwed = input.claims.reduce((s, c) => s.plus(owedOn(c)), new D(0));
  const items: ExpenseReconItem[] = [];
  // Entries that no claim made, one item each.
  for (const l of lines.filter((x) => !claimOf.has(x.entryId))) {
    if (new D(l.net).isZero()) continue;
    items.push({
      kind: 'NOT_FROM_A_CLAIM',
      date: l.date,
      reference: l.entryNumber != null ? `JE-${l.entryNumber}` : 'Journal',
      description: `${l.memo ? `${l.memo}: ` : ''}an entry on the account that no expense claim made (${l.source.toLowerCase().replace(/_/g, ' ')})`,
      amount: new D(l.net).toFixed(scale),
      entryId: l.entryId,
      claimId: null,
    });
  }
  // Claims whose own entries do not come to what they say is owed.
  for (const c of input.claims) {
    const onLedger = lines.filter((l) => claimOf.get(l.entryId) === c).reduce((s, l) => s.plus(l.net), new D(0));
    const diff = onLedger.minus(owedOn(c));
    if (diff.isZero()) continue;
    items.push({
      kind: 'CLAIM_DIFFERS',
      date: c.approvedOn,
      reference: c.number,
      description: `Its entries show ${money(onLedger)} owed on ${formatDateText(asOf)}; the claim says ${money(owedOn(c))}`,
      amount: diff.toFixed(scale),
      entryId: null,
      claimId: c.id,
    });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));

  const owed = input.claims
    .filter((c) => owedOn(c).gt(0))
    .map((c) => {
      const days = Math.max(0, daysBetween(c.approvedOn, asOf)); // not money: days
      return { id: c.id, number: c.number, claimant: c.claimant, claimantId: c.claimantId, title: c.title, amount: new D(c.total).toFixed(scale), approvedOn: c.approvedOn, days, overdue: days > EXPENSE_RECON_OVERDUE_DAYS };
    })
    .sort((a, b) => b.days - a.days || a.number.localeCompare(b.number));
  const ages = EXPENSE_RECON_AGES.map((a, i) => {
    const from = i ? EXPENSE_RECON_AGES[i - 1]!.to + 1 : 0;
    const xs = owed.filter((o) => o.days >= from && o.days <= a.to);
    return { key: a.key, label: a.label, claims: xs.length, amount: xs.reduce((s, o) => s.plus(o.amount), new D(0)).toFixed(scale) };
  });
  const people = new Map<string, typeof owed>();
  for (const o of owed) people.set(o.claimantId, [...(people.get(o.claimantId) ?? []), o]);
  const employees = [...people.entries()]
    .map(([claimantId, xs]) => ({
      claimantId,
      claimant: xs[0]!.claimant,
      claims: xs.length,
      amount: xs.reduce((s, o) => s.plus(o.amount), new D(0)).toFixed(scale),
      oldestDays: Math.max(...xs.map((o) => o.days)), // not money: days
      overdue: xs.filter((o) => o.overdue).reduce((s, o) => s.plus(o.amount), new D(0)).toFixed(scale),
    }))
    .sort((a, b) => new D(b.amount).comparedTo(new D(a.amount)) || a.claimant.localeCompare(b.claimant));
  const late = owed.filter((o) => o.overdue);

  const since = addDays(asOf, -EXPENSE_RECON_REIMBURSED_DAYS);
  const reimbursements = input.reimbursements
    .filter((r) => r.date > since && r.date <= asOf)
    .map((r) => {
      const status: ReimbursementBankStatus = r.matched ? 'CLEARED' : r.statementThrough && r.statementThrough >= addDays(r.date, EXPENSE_RECON_STATEMENT_GRACE) ? 'NOT_ON_STATEMENT' : 'AWAITING_STATEMENT';
      return { ...r, amount: new D(r.amount).toFixed(scale), status, statusLabel: REIMBURSEMENT_BANK_LABEL[status], days: daysBetween(r.date, asOf) }; // not money: days
    })
    .sort((a, b) => Number(a.status === 'CLEARED') - Number(b.status === 'CLEARED') || a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  const missing = reimbursements.filter((r) => r.status === 'NOT_ON_STATEMENT');

  const difference = ledger.minus(claimsOwed);
  return {
    asOf,
    ledger: ledger.toFixed(scale),
    claims: claimsOwed.toFixed(scale),
    difference: difference.toFixed(scale),
    reconciled: difference.isZero() && !items.length,
    items,
    owed: owed.map(({ claimantId: _c, ...o }) => o),
    ages,
    employees,
    overdue: { claims: late.length, amount: late.reduce((s, o) => s.plus(o.amount), new D(0)).toFixed(scale) },
    reimbursements,
    bank: {
      cleared: reimbursements.filter((r) => r.status === 'CLEARED').length,
      notOnStatement: missing.length,
      notOnStatementAmount: missing.reduce((s, r) => s.plus(r.amount), new D(0)).toFixed(scale),
      awaiting: reimbursements.filter((r) => r.status === 'AWAITING_STATEMENT').length,
    },
  };
}
