/**
 * Statement of cash flows by the indirect method (RPT-004).
 *
 * Every posted journal balances, so over any period the change in cash and bank
 * equals the opposite of the change in every other account. The statement
 * groups those other changes:
 *
 *   operating  = profit for the period, plus depreciation (the rise in
 *                accumulated depreciation), plus the change in working capital
 *                (receivables, stock, prepayments, payables, taxes, payroll and
 *                other current balances)
 *   investing  = fixed assets and other non-current assets bought or sold
 *   financing  = long-term borrowings, share capital, drawings and other equity
 *
 * Each line is (credits - debits) on the account over the period: a rise in an
 * asset uses cash (negative), a rise in a liability or equity brings it in.
 * Closing entries are left out of the period's movements, so profit is the
 * period's profit and retained earnings shows only direct entries.
 */
import { AccountType } from './accounts';
import { D, Dec, dec, sum } from './money';
import type { AccountMovement } from './reports';

export type CashFlowSection = 'OPERATING' | 'INVESTING' | 'FINANCING';

export const CASH_SUBTYPES: readonly string[] = ['CASH', 'BANK'];

/** Where each balance-sheet subtype sits on the statement. */
export const CASH_FLOW_PLACEMENT: Readonly<Record<string, { section: CashFlowSection; group: CashFlowGroup }>> = Object.freeze({
  ACCUMULATED_DEPRECIATION: { section: 'OPERATING', group: 'NON_CASH' },
  ACCOUNTS_RECEIVABLE: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  INVENTORY: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  PREPAID: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  OTHER_CURRENT_ASSET: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  TAX_RECEIVABLE: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  ACCOUNTS_PAYABLE: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  EMPLOYEE_REIMBURSEMENTS: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  CREDIT_CARD: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  ACCRUED_LIABILITY: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  TAX_PAYABLE: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  PAYROLL_LIABILITY: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  OTHER_CURRENT_LIABILITY: { section: 'OPERATING', group: 'WORKING_CAPITAL' },
  FIXED_ASSET: { section: 'INVESTING', group: 'INVESTING' },
  OTHER_NON_CURRENT_ASSET: { section: 'INVESTING', group: 'INVESTING' },
  LONG_TERM_DEBT: { section: 'FINANCING', group: 'FINANCING' },
  OTHER_NON_CURRENT_LIABILITY: { section: 'FINANCING', group: 'FINANCING' },
  SHARE_CAPITAL: { section: 'FINANCING', group: 'FINANCING' },
  OWNER_DRAWINGS: { section: 'FINANCING', group: 'FINANCING' },
  RETAINED_EARNINGS: { section: 'FINANCING', group: 'FINANCING' },
  OTHER_EQUITY: { section: 'FINANCING', group: 'FINANCING' },
});

export type CashFlowGroup = 'NON_CASH' | 'WORKING_CAPITAL' | 'INVESTING' | 'FINANCING' | 'UNCLASSIFIED';

export interface CashFlowLine {
  accountId: string;
  code: string;
  name: string;
  subtype: string | null;
  group: CashFlowGroup;
  /** Cash in (positive) or out (negative) from this account's change. */
  amount: Dec;
}

export interface CashFlowStatement {
  profit: Dec;
  operating: { lines: CashFlowLine[]; total: Dec };
  investing: { lines: CashFlowLine[]; total: Dec };
  financing: { lines: CashFlowLine[]; total: Dec };
  /** Change in cash and bank accounts, read from those accounts. */
  netChange: Dec;
  /** Operating + investing + financing; equals netChange when the ledger balances. */
  explained: Dec;
  reconciles: boolean;
  /** Balance-sheet accounts with no subtype: shown under operating, and named here. */
  unclassified: string[];
}

const toDec = (v: string | Dec): Dec => (typeof v === 'string' ? dec(v) : v);
const isPnl = (t: AccountType) => t === 'REVENUE' || t === 'EXPENSE';

/** Build the statement from each account's posted movements over the period (closing entries left out). */
export function buildCashFlowStatement(movements: readonly AccountMovement[]): CashFlowStatement {
  const lines: (CashFlowLine & { section: CashFlowSection })[] = [];
  const unclassified: string[] = [];
  let profit = new D(0);
  let netChange = new D(0);
  for (const m of movements) {
    const inflow = toDec(m.credit).minus(toDec(m.debit));
    if (isPnl(m.type)) {
      profit = profit.plus(inflow);
      continue;
    }
    if (m.subtype && CASH_SUBTYPES.includes(m.subtype)) {
      netChange = netChange.minus(inflow);
      continue;
    }
    if (inflow.isZero()) continue;
    const place = m.subtype ? CASH_FLOW_PLACEMENT[m.subtype] : undefined;
    if (!place) unclassified.push(`${m.code} ${m.name}`);
    lines.push({ accountId: m.accountId, code: m.code, name: m.name, subtype: m.subtype ?? null, group: place?.group ?? 'UNCLASSIFIED', section: place?.section ?? 'OPERATING', amount: inflow });
  }
  const order: Record<CashFlowGroup, number> = { NON_CASH: 0, WORKING_CAPITAL: 1, UNCLASSIFIED: 2, INVESTING: 3, FINANCING: 4 };
  lines.sort((a, b) => order[a.group] - order[b.group] || a.code.localeCompare(b.code));
  const pick = (s: CashFlowSection) => lines.filter((l) => l.section === s).map(({ section: _s, ...l }) => l);
  const operatingLines = pick('OPERATING');
  const investingLines = pick('INVESTING');
  const financingLines = pick('FINANCING');
  const operating = { lines: operatingLines, total: profit.plus(sum(operatingLines.map((l) => l.amount))) };
  const investing = { lines: investingLines, total: sum(investingLines.map((l) => l.amount)) };
  const financing = { lines: financingLines, total: sum(financingLines.map((l) => l.amount)) };
  const explained = operating.total.plus(investing.total).plus(financing.total);
  return { profit, operating, investing, financing, netChange, explained, reconciles: explained.equals(netChange), unclassified };
}
