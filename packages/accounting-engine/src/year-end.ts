import { D, dec, Dec, minorUnits } from './money';

/**
 * Year-end close (GL-011 closing balances). At the end of a fiscal year the revenue and expense
 * accounts are brought to nil and their net, the year's profit or loss, is moved to retained
 * earnings with one closing journal dated the last day of the year.
 *
 * Closing journals have the journal type CLOSING, and profit-and-loss reports leave that type out:
 * the year's income statement still shows what was earned, while the balance sheet carries the
 * profit in retained earnings instead of as earnings not yet closed.
 *
 * Closing is self-correcting. The lines are worked out from each account's balance for the year
 * *including* closing entries already posted, so a second close after a late adjustment posts only
 * what is left, and a year already closed posts nothing.
 */

export interface YearEndAccount {
  accountId: string;
  code: string;
  name: string;
  type: 'REVENUE' | 'EXPENSE';
  /** Functional debits and credits posted in the year, closing entries included. */
  debit: string;
  credit: string;
}

export interface ClosingLine {
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}

export interface YearEndClosing {
  /** Lines that bring each account to nil, then the retained-earnings line. Empty when nothing is left. */
  lines: ClosingLine[];
  /** What moves to retained earnings: positive for a profit (a credit), negative for a loss. */
  toRetainedEarnings: string;
  /** Accounts with something left to close. */
  accounts: number;
}

export class YearEndError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The closing journal for the balances left in the year's revenue and expense accounts. */
export function yearEndClosing(accounts: readonly YearEndAccount[], retainedEarningsAccountId: string, label: string, currency: string): YearEndClosing {
  const scale = minorUnits(currency);
  const lines: ClosingLine[] = [];
  let total = new D(0);
  for (const a of [...accounts].sort((x, y) => x.code.localeCompare(y.code))) {
    if (a.accountId === retainedEarningsAccountId) throw new YearEndError('RE_IS_PL', 'Retained earnings must be an equity account, not a revenue or expense account');
    const net = dec(a.debit).minus(dec(a.credit)).toDecimalPlaces(scale);
    if (net.isZero()) continue;
    total = total.plus(net);
    // A debit balance is closed with a credit, a credit balance with a debit.
    lines.push({ accountId: a.accountId, debit: net.isNegative() ? net.negated().toFixed(scale) : (0).toFixed(scale), credit: net.isPositive() ? net.toFixed(scale) : (0).toFixed(scale), description: `${label}: ${a.code} ${a.name} closed` });
  }
  if (lines.length === 0) return { lines, toRetainedEarnings: (0).toFixed(scale), accounts: 0 };
  // Debit balances left over overall (a loss) are charged to retained earnings; credit (a profit) is credited.
  const profit = total.negated();
  if (!profit.isZero()) {
    lines.push({
      accountId: retainedEarningsAccountId,
      debit: profit.isNegative() ? profit.negated().toFixed(scale) : (0).toFixed(scale),
      credit: profit.isPositive() ? profit.toFixed(scale) : (0).toFixed(scale),
      description: `${label}: ${profit.isNegative() ? 'loss' : 'profit'} to retained earnings`,
    });
  }
  return { lines, toRetainedEarnings: profit.toFixed(scale), accounts: lines.length - (profit.isZero() ? 0 : 1) };
}

/** Profit for the year from revenue and expense movements (closing entries left out): revenue less expenses. */
export function yearProfit(accounts: readonly Pick<YearEndAccount, 'debit' | 'credit'>[], currency: string): string {
  const scale = minorUnits(currency);
  const net = accounts.reduce<Dec>((s, a) => s.plus(dec(a.credit)).minus(dec(a.debit)), new D(0));
  return net.toFixed(scale);
}

export type YearEndStatus = 'NOTHING_TO_CLOSE' | 'NOT_CLOSED' | 'CLOSED' | 'OUT_OF_DATE';

/**
 * Where a year stands: nothing left in revenue or expense accounts and never closed, not closed
 * yet, closed (nothing left), or closed but changed since (something left to close again).
 */
export function yearEndStatus(input: { hasActiveClose: boolean; accountsLeft: number }): YearEndStatus {
  if (input.accountsLeft === 0) return input.hasActiveClose ? 'CLOSED' : 'NOTHING_TO_CLOSE';
  return input.hasActiveClose ? 'OUT_OF_DATE' : 'NOT_CLOSED';
}

export const YEAR_END_STATUS_LABEL: Record<YearEndStatus, string> = {
  NOTHING_TO_CLOSE: 'Nothing to close',
  NOT_CLOSED: 'Not closed',
  CLOSED: 'Closed',
  OUT_OF_DATE: 'Changed since closing',
};
