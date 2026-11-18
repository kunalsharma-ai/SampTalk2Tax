import { D, type Dec } from './money';

/**
 * Balance sheet account reconciliation (GL-032): at a date, the ledger balance of an account is
 * explained by a list of supporting items (open invoices, a loan statement, a prepaid schedule,
 * a payroll liability report, ...). What the items do not explain is the difference, and a
 * reconciliation can only be signed off when the difference is nil. Amounts are in the
 * account's natural sign: debit balances positive for assets, credit balances positive for
 * liabilities and equity.
 */

export type ReconItemKind = 'SUPPORT' | 'RECONCILING';

export interface ReconItemInput {
  description: string;
  reference?: string | null;
  amount: string;
  kind: ReconItemKind;
}

export const RECON_ITEM_KINDS: Record<ReconItemKind, string> = {
  SUPPORT: 'Supporting balance',
  RECONCILING: 'Reconciling item',
};

/** The natural balance of an account from its debit and credit totals. */
export function naturalBalance(type: string, debit: Dec, credit: Dec): Dec {
  return type === 'ASSET' || type === 'EXPENSE' ? debit.minus(credit) : credit.minus(debit);
}

export interface ReconSummary {
  supported: Dec;
  reconciling: Dec;
  explained: Dec;
  difference: Dec;
  balanced: boolean;
}

/** What the items explain of the ledger balance, and what is left over. */
export function reconcileAccount(ledgerBalance: Dec | string, items: readonly { amount: string | Dec; kind: ReconItemKind }[], scale = 2): ReconSummary {
  const ledger = new D(ledgerBalance.toString());
  let supported = new D(0);
  let reconciling = new D(0);
  for (const i of items) {
    const a = new D(i.amount.toString()).toDecimalPlaces(scale);
    if (i.kind === 'SUPPORT') supported = supported.plus(a);
    else reconciling = reconciling.plus(a);
  }
  const explained = supported.plus(reconciling);
  const difference = ledger.toDecimalPlaces(scale).minus(explained);
  return { supported, reconciling, explained, difference, balanced: difference.isZero() };
}

/** Problems with the items as entered, or an empty list. */
export function reconItemIssues(items: readonly ReconItemInput[], scale = 2): string[] {
  const issues: string[] = [];
  items.forEach((i, n) => {
    const at = `Item ${n + 1}`;
    if (!i.description.trim()) issues.push(`${at}: say what it is`);
    let a: Dec | null = null;
    try {
      a = new D(i.amount);
    } catch {
      issues.push(`${at}: the amount ${i.amount || '(blank)'} is not a number`);
    }
    if (a && !a.isFinite()) issues.push(`${at}: the amount ${i.amount} is not a number`);
    else if (a && a.decimalPlaces() > scale) issues.push(`${at}: use at most ${scale} decimal places`);
    else if (a && a.isZero()) issues.push(`${at}: an item of nil does not explain anything`);
  });
  return issues;
}

export type ReconState = 'NOT_STARTED' | 'DRAFT' | 'PREPARED' | 'REVIEWED' | 'CHANGED';

/**
 * Where an account stands for a date: never started, being worked on, prepared (balanced and
 * waiting for a reviewer), reviewed, or changed (the ledger moved after it was signed off, so
 * the work no longer matches the books).
 */
export function reconState(rec: { status: 'DRAFT' | 'PREPARED' | 'REVIEWED'; ledgerBalance: string | Dec } | null, currentBalance: Dec | string): ReconState {
  if (!rec) return 'NOT_STARTED';
  if (rec.status !== 'DRAFT' && !new D(rec.ledgerBalance.toString()).equals(new D(currentBalance.toString()))) return 'CHANGED';
  return rec.status;
}
