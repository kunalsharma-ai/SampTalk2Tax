/**
 * Opening balances (GL-010): the balances a business brings into Talk2Tax on the day it starts
 * keeping its books here, entered account by account and posted as one OPENING journal. Whatever
 * does not balance goes to Opening Balance Equity, which the accountant clears once the figures
 * are agreed (a balance left there means something is missing or wrong).
 * No framework or database code. Money is decimal strings.
 */
import { D, Dec, minorUnits } from './money';

export const OPENING_BALANCE_EQUITY = { code: '3250', name: 'Opening Balance Equity', type: 'EQUITY' as const, subtype: 'OTHER_EQUITY' };
/** The reference every opening-balance journal carries, so the current one can be found and replaced. */
export const OPENING_REFERENCE = 'OPENING-BALANCES';

export interface OpeningAccount {
  id: string;
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
}

export interface OpeningLineInput {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
}

export interface OpeningPlan {
  /** Journal lines: one per account with a balance, then the difference to Opening Balance Equity when there is one. */
  lines: { accountId: string; debit: string; credit: string; description: string }[];
  totalDebit: string;
  totalCredit: string;
  /** Debits minus credits of the entered balances; the opposite goes to Opening Balance Equity. */
  difference: string;
  /** Problems that stop the balances being posted. */
  issues: string[];
  /** Points to check that do not stop posting. */
  warnings: string[];
}

/**
 * Turns entered balances into the lines of the opening journal. Each account takes a debit or a
 * credit of a positive amount in the currency's minor units (blank or zero means no balance);
 * an account may appear once; Opening Balance Equity itself is not entered.
 */
export function planOpeningBalances(input: { currency: string; accounts: readonly OpeningAccount[]; lines: readonly OpeningLineInput[]; offsetAccountId: string | null }): OpeningPlan {
  const scale = minorUnits(input.currency);
  const amount = scale ? new RegExp(`^\\d{1,15}(\\.\\d{1,${scale}})?$`) : /^\d{1,15}$/;
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const issues: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const lines: OpeningPlan['lines'] = [];
  let debit = new D(0);
  let credit = new D(0);
  const label = (a: OpeningAccount | undefined, id: string) => (a ? `${a.code} ${a.name}` : id);
  for (const l of input.lines) {
    const acc = byId.get(l.accountId);
    const d = (l.debit ?? '').trim();
    const c = (l.credit ?? '').trim();
    const zero = (v: string) => v === '' || (amount.test(v) && new D(v).isZero());
    if (zero(d) && zero(c)) continue;
    if (l.accountId === input.offsetAccountId) {
      issues.push(`${acc ? label(acc, l.accountId) : `${OPENING_BALANCE_EQUITY.code} ${OPENING_BALANCE_EQUITY.name}`} takes the difference: leave it out`);
      continue;
    }
    if (!acc) {
      issues.push(`${l.accountId} is not an account that can take an opening balance`);
      continue;
    }
    if (seen.has(l.accountId)) {
      issues.push(`${label(acc, l.accountId)} is entered twice`);
      continue;
    }
    seen.add(l.accountId);
    if (!zero(d) && !zero(c)) {
      issues.push(`${label(acc, l.accountId)}: enter a debit or a credit, not both`);
      continue;
    }
    const v = zero(d) ? c : d;
    if (!amount.test(v)) {
      issues.push(`${label(acc, l.accountId)}: "${v}" is not ${scale ? `an amount with at most ${scale} decimal places` : `a whole amount in ${input.currency}`}`);
      continue;
    }
    const isDebit = !zero(d);
    const value = new D(v);
    if (isDebit) debit = debit.plus(value);
    else credit = credit.plus(value);
    lines.push({ accountId: acc.id, debit: isDebit ? value.toFixed(scale) : new D(0).toFixed(scale), credit: isDebit ? new D(0).toFixed(scale) : value.toFixed(scale), description: 'Opening balance' });
    const natural = acc.type === 'ASSET' || acc.type === 'EXPENSE' ? 'debit' : 'credit';
    if ((natural === 'debit') !== isDebit) warnings.push(`${label(acc, l.accountId)} usually has a ${natural} balance`);
    if (acc.type === 'REVENUE' || acc.type === 'EXPENSE') warnings.push(`${label(acc, l.accountId)} is an income or expense account: enter it only when the books start part-way through a financial year`);
  }
  if (!lines.length && !issues.length) issues.push('Enter at least one balance');
  const difference: Dec = debit.minus(credit);
  if (!difference.isZero()) {
    if (!input.offsetAccountId) issues.push('There is no Opening Balance Equity account to take the difference');
    else lines.push({ accountId: input.offsetAccountId, debit: difference.isNeg() ? difference.abs().toFixed(scale) : new D(0).toFixed(scale), credit: difference.isPos() ? difference.toFixed(scale) : new D(0).toFixed(scale), description: 'Difference in the opening balances' });
  }
  const total = debit.gt(credit) ? debit : credit;
  return { lines, totalDebit: total.toFixed(scale), totalCredit: total.toFixed(scale), difference: difference.toFixed(scale), issues, warnings };
}
