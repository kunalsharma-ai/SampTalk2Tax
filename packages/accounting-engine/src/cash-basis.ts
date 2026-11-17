import { D, Dec, dec } from './money';
import type { AccountMovement } from './reports';

/**
 * Cash-basis profit and loss (Directive Part 5.1, GL-014). The books are kept on an accrual
 * basis; the cash view is derived from them. Income and expenses count when money moves:
 *
 * - direct: income and expense lines of entries that themselves move a bank or cash account
 *   (money received or spent with no invoice or bill), counted in full on their date;
 * - settled: an accrual entry (an invoice, bill, credit note, expense claim or pay run) counts
 *   in the share that was paid or applied in the period: its income and expense lines ×
 *   settled / total. A bill half paid in March counts half in March.
 *
 * Everything else (depreciation, accruals and other entries never settled in cash) is left
 * out; the report shows the difference from the accrual result.
 */

export interface CashLine {
  accountId: string;
  debit: string | Dec;
  credit: string | Dec;
}

export interface CashSettlement {
  /** The accrual entry's lines (all of them; only income and expense accounts count). */
  lines: CashLine[];
  /** What was paid or applied in the period, and the whole the entry stands for (same currency). */
  settled: string | Dec;
  total: string | Dec;
}

export function cashBasisMovements(accounts: readonly Omit<AccountMovement, 'debit' | 'credit'>[], direct: readonly CashLine[], settlements: readonly CashSettlement[]): AccountMovement[] {
  const pl = new Set(accounts.filter((a) => a.type === 'REVENUE' || a.type === 'EXPENSE').map((a) => a.accountId));
  const sums = new Map<string, { debit: Dec; credit: Dec }>();
  const add = (l: CashLine, share: Dec) => {
    if (!pl.has(l.accountId)) return;
    const s = sums.get(l.accountId) ?? { debit: dec('0'), credit: dec('0') };
    sums.set(l.accountId, { debit: s.debit.plus(dec(l.debit).times(share)), credit: s.credit.plus(dec(l.credit).times(share)) });
  };
  for (const l of direct) add(l, dec('1'));
  for (const s of settlements) {
    const total = dec(s.total);
    if (!total.gt(0)) continue;
    const share = D.min(dec(s.settled).div(total), dec('1'));
    if (!share.gt(0)) continue;
    for (const l of s.lines) add(l, share);
  }
  return accounts.map((a) => ({ ...a, debit: sums.get(a.accountId)?.debit ?? dec('0'), credit: sums.get(a.accountId)?.credit ?? dec('0') }));
}
