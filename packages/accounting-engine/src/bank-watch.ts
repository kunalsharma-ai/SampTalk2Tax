import { D, type Dec } from './money';

/**
 * Bank account watch (BANK-014): bank and cash accounts whose balance in the books is low or
 * overdrawn, and accounts not reconciled to a statement for too long while they have activity.
 * The balance is the ledger balance, not one reported by the bank.
 */

export interface WatchedAccount {
  id: string;
  code: string;
  name: string;
  subtype: string | null;
  ledgerBalance: string;
  /** Statement lines imported and not yet matched. */
  unmatchedLines: number;
  /** The statement date of the latest completed reconciliation, or null. */
  lastReconciled: string | null;
  /** The first day the account had a posted line, or null when it never had one. */
  firstActivity: string | null;
}

export type BankWatchCode = 'OVERDRAWN' | 'LOW_BALANCE' | 'NOT_RECONCILED';

export interface BankWatchFinding {
  accountId: string;
  code: BankWatchCode;
  severity: 'CRITICAL' | 'WARNING';
  balance: Dec;
  /** Days since the last reconciliation (or since the first activity when never reconciled). */
  days: number | null;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function bankWatch(accounts: readonly WatchedAccount[], today: string, opts: { minBalance: Dec | string; unreconciledDays: number }): BankWatchFinding[] {
  const min = new D(opts.minBalance.toString());
  const out: BankWatchFinding[] = [];
  for (const a of accounts) {
    // An account never used (an unused cash box from the chart) has nothing to watch.
    if (!a.firstActivity) continue;
    const balance = new D(a.ledgerBalance);
    if (balance.isNeg()) out.push({ accountId: a.id, code: 'OVERDRAWN', severity: 'CRITICAL', balance, days: null });
    else if (min.gt(0) && balance.lt(min)) out.push({ accountId: a.id, code: 'LOW_BALANCE', severity: 'WARNING', balance, days: null });
    // Cash in hand has no statement to reconcile to.
    if (a.subtype === 'CASH') continue;
    const since = a.lastReconciled ?? a.firstActivity;
    const days = daysBetween(since, today);
    if (days > opts.unreconciledDays) out.push({ accountId: a.id, code: 'NOT_RECONCILED', severity: 'WARNING', balance, days });
  }
  return out;
}
