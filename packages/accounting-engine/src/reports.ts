import { AccountType, isBalanceSheetType, normalBalance } from './accounts';
import { D, Dec, dec, sum } from './money';

/** Aggregated functional-currency movement for one account over some date range. */
export interface AccountMovement {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype?: string | null;
  debit: string | Dec;
  credit: string | Dec;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype?: string | null;
  debit: Dec; // total debits
  credit: Dec; // total credits
  /** Net balance shown on the account's normal side (positive = normal). */
  balance: Dec;
  /** Net presented in a single debit or credit column. */
  netDebit: Dec;
  netCredit: Dec;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: Dec;
  totalCredit: Dec;
  totalNetDebit: Dec;
  totalNetCredit: Dec;
  balanced: boolean;
}

const toDec = (v: string | Dec): Dec => (typeof v === 'string' ? dec(v) : v);

export function buildTrialBalance(movements: readonly AccountMovement[], opts: { includeZero?: boolean } = {}): TrialBalance {
  const rows: TrialBalanceRow[] = movements
    .map((m) => {
      const debit = toDec(m.debit);
      const credit = toDec(m.credit);
      const net = debit.minus(credit);
      const balance = normalBalance(m.type) === 'DEBIT' ? net : net.negated();
      return {
        accountId: m.accountId,
        code: m.code,
        name: m.name,
        type: m.type,
        subtype: m.subtype ?? null,
        debit,
        credit,
        balance,
        netDebit: net.isPositive() ? net : new D(0),
        netCredit: net.isNegative() ? net.negated() : new D(0),
      };
    })
    .filter((r) => opts.includeZero || !r.debit.isZero() || !r.credit.isZero())
    .sort((a, b) => a.code.localeCompare(b.code));

  const totalDebit = sum(rows.map((r) => r.debit));
  const totalCredit = sum(rows.map((r) => r.credit));
  const totalNetDebit = sum(rows.map((r) => r.netDebit));
  const totalNetCredit = sum(rows.map((r) => r.netCredit));
  return {
    rows,
    totalDebit,
    totalCredit,
    totalNetDebit,
    totalNetCredit,
    balanced: totalDebit.equals(totalCredit) && totalNetDebit.equals(totalNetCredit),
  };
}

export interface StatementLine {
  accountId: string;
  code: string;
  name: string;
  subtype?: string | null;
  amount: Dec;
}

export interface IncomeStatement {
  revenue: StatementLine[];
  expenses: StatementLine[];
  totalRevenue: Dec;
  totalExpenses: Dec;
  netIncome: Dec;
}

/** Income statement from movements over a date range (revenue and expense accounts only). */
export function buildIncomeStatement(movements: readonly AccountMovement[]): IncomeStatement {
  const tb = buildTrialBalance(movements);
  const revenue = tb.rows.filter((r) => r.type === 'REVENUE').map(toLine);
  const expenses = tb.rows.filter((r) => r.type === 'EXPENSE').map(toLine);
  const totalRevenue = sum(revenue.map((l) => l.amount));
  const totalExpenses = sum(expenses.map((l) => l.amount));
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue.minus(totalExpenses) };
}

export interface BalanceSheet {
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  /** Cumulative revenue minus expenses not yet closed to retained earnings. */
  unclosedEarnings: Dec;
  totalAssets: Dec;
  totalLiabilities: Dec;
  totalEquity: Dec; // includes unclosedEarnings
  balanced: boolean;
}

/** Balance sheet from cumulative movements from inception up to the report date. */
export function buildBalanceSheet(cumulative: readonly AccountMovement[]): BalanceSheet {
  const tb = buildTrialBalance(cumulative);
  const assets = tb.rows.filter((r) => r.type === 'ASSET').map(toLine);
  const liabilities = tb.rows.filter((r) => r.type === 'LIABILITY').map(toLine);
  const equity = tb.rows.filter((r) => r.type === 'EQUITY').map(toLine);
  const pnl = tb.rows.filter((r) => !isBalanceSheetType(r.type));
  const unclosedEarnings = sum(pnl.map((r) => (r.type === 'REVENUE' ? r.balance : r.balance.negated())));
  const totalAssets = sum(assets.map((l) => l.amount));
  const totalLiabilities = sum(liabilities.map((l) => l.amount));
  const totalEquity = sum(equity.map((l) => l.amount)).plus(unclosedEarnings);
  return {
    assets,
    liabilities,
    equity,
    unclosedEarnings,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
  };
}

function toLine(r: TrialBalanceRow): StatementLine {
  return { accountId: r.accountId, code: r.code, name: r.name, subtype: r.subtype, amount: r.balance };
}

export interface LedgerEntryLike {
  date: string;
  entryNumber: number;
  journalId: string;
  memo?: string | null;
  description?: string | null;
  debit: string | Dec;
  credit: string | Dec;
}

export interface LedgerRow extends Omit<LedgerEntryLike, 'debit' | 'credit'> {
  debit: Dec;
  credit: Dec;
  runningBalance: Dec;
}

/** Account ledger with running balance on the account's normal side. */
export function buildAccountLedger(type: AccountType, opening: Dec, entries: readonly LedgerEntryLike[]): LedgerRow[] {
  const sign = normalBalance(type) === 'DEBIT' ? 1 : -1;
  let running = opening;
  return [...entries]
    .sort((a, b) => (a.date === b.date ? a.entryNumber - b.entryNumber : a.date.localeCompare(b.date)))
    .map((e) => {
      const debit = toDec(e.debit);
      const credit = toDec(e.credit);
      running = running.plus(debit.minus(credit).times(sign));
      return { ...e, debit, credit, runningBalance: running };
    });
}
