import { JournalLineInput } from './journal';
import { D, Dec, MoneyError, assertCurrencyPrecision, dec, roundToCurrency, sum } from './money';
import { assertIsoDate } from './periods';
import { DocumentValidationError, TaxRateInfo } from './documents';

/**
 * Employee expense claims (Directive Part 13). An employee spends their own money and
 * asks to be paid back. Each line is what the receipt says was paid, tax included;
 * when a tax rate applies, the recoverable tax is split out of that amount.
 *
 * Approving a claim posts: Dr expense (net) and Dr input tax / Cr employee
 * reimbursements payable (the claim total). Reimbursing it posts:
 * Dr employee reimbursements payable / Cr bank.
 */
export interface ExpenseLineInput {
  date: string;
  accountId: string;
  merchant?: string | null;
  description?: string | null;
  /** What was paid, tax included. Decimal string > 0 in the claim currency. */
  amount: string;
  taxRateId?: string | null;
}

export interface ComputedExpenseLine {
  lineNo: number;
  date: string;
  accountId: string;
  merchant: string | null;
  description: string | null;
  taxRateId: string | null;
  taxRate: Dec;
  taxAccountId: string | null;
  amount: Dec;
  netAmount: Dec;
  taxAmount: Dec;
}

export interface ComputedExpenseClaim {
  lines: ComputedExpenseLine[];
  netTotal: Dec;
  taxTotal: Dec;
  total: Dec;
}

export const MAX_EXPENSE_LINES = 100;

/** Tax contained in a tax-inclusive amount: amount × rate / (100 + rate), rounded half-even. */
export function includedTax(amount: Dec, ratePercent: Dec, currency: string): Dec {
  if (ratePercent.isZero()) return new D(0);
  return roundToCurrency(amount.times(ratePercent).dividedBy(ratePercent.plus(100)), currency);
}

export function computeExpenseClaim(lines: ExpenseLineInput[], currency: string, taxRates: ReadonlyMap<string, TaxRateInfo>): ComputedExpenseClaim {
  const issues: string[] = [];
  if (lines.length === 0) issues.push('A claim needs at least one line');
  if (lines.length > MAX_EXPENSE_LINES) issues.push(`A claim can have at most ${MAX_EXPENSE_LINES} lines`);
  const out: ComputedExpenseLine[] = [];
  lines.forEach((l, i) => {
    const n = i + 1;
    let amount: Dec;
    try {
      amount = dec(l.amount);
      assertCurrencyPrecision(amount, currency, `Line ${n} amount`);
    } catch (e) {
      issues.push(e instanceof MoneyError ? `Line ${n}: ${e.message}` : `Line ${n}: invalid amount`);
      return;
    }
    if (amount.lte(0)) {
      issues.push(`Line ${n}: amount must be greater than zero`);
      return;
    }
    try {
      assertIsoDate(l.date);
    } catch {
      issues.push(`Line ${n}: date must be YYYY-MM-DD`);
      return;
    }
    let rate = new D(0);
    let taxAccountId: string | null = null;
    if (l.taxRateId) {
      const t = taxRates.get(l.taxRateId);
      if (!t) {
        issues.push(`Line ${n}: tax rate not found`);
        return;
      }
      rate = dec(t.rate);
      taxAccountId = t.accountId;
      if (rate.gt(0) && !taxAccountId) issues.push(`Line ${n}: tax rate ${t.name} has no account for purchases tax`);
    }
    const tax = includedTax(amount, rate, currency);
    out.push({
      lineNo: n,
      date: l.date,
      accountId: l.accountId,
      merchant: l.merchant?.trim() || null,
      description: l.description?.trim() || null,
      taxRateId: l.taxRateId ?? null,
      taxRate: rate,
      taxAccountId,
      amount,
      netAmount: amount.minus(tax),
      taxAmount: tax,
    });
  });
  if (issues.length) throw new DocumentValidationError(issues);
  const total = sum(out.map((l) => l.amount));
  const taxTotal = sum(out.map((l) => l.taxAmount));
  return { lines: out, netTotal: total.minus(taxTotal), taxTotal, total };
}

/** Dr each expense account (net) and tax account / Cr the reimbursements payable account. */
export function buildExpenseClaimJournal(claim: ComputedExpenseClaim, payableAccountId: string, currency: string): JournalLineInput[] {
  const out: JournalLineInput[] = [{ accountId: payableAccountId, currency, credit: claim.total.toFixed(), description: 'Owed to employee' }];
  for (const l of claim.lines) {
    if (l.netAmount.gt(0)) out.push({ accountId: l.accountId, currency, debit: l.netAmount.toFixed(), description: [l.merchant, l.description].filter(Boolean).join(' · ') || undefined });
  }
  const taxByAccount = new Map<string, Dec>();
  for (const l of claim.lines) {
    if (l.taxAmount.gt(0) && l.taxAccountId) taxByAccount.set(l.taxAccountId, (taxByAccount.get(l.taxAccountId) ?? new D(0)).plus(l.taxAmount));
  }
  for (const [accountId, amount] of taxByAccount) out.push({ accountId, currency, debit: amount.toFixed(), description: 'Tax on expenses' });
  return out;
}

/** Dr reimbursements payable / Cr bank. */
export function buildReimbursementJournal(amount: Dec, bankAccountId: string, payableAccountId: string, currency: string): JournalLineInput[] {
  if (amount.lte(0)) throw new MoneyError('Reimbursement amount must be greater than zero');
  assertCurrencyPrecision(amount, currency, 'Reimbursement amount');
  return [
    { accountId: payableAccountId, currency, debit: amount.toFixed(), description: 'Reimbursed to employee' },
    { accountId: bankAccountId, currency, credit: amount.toFixed() },
  ];
}

/**
 * Lines in other claims by the same person with the same date and amount: a hint that a
 * receipt may have been claimed twice. Returns, per line number, the matching claim numbers.
 */
export function possibleDuplicateLines(
  lines: { lineNo: number; date: string; amount: Dec }[],
  others: { claimLabel: string; date: string; amount: Dec }[],
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const l of lines) {
    const hits = [...new Set(others.filter((o) => o.date === l.date && o.amount.eq(l.amount)).map((o) => o.claimLabel))];
    if (hits.length) out.set(l.lineNo, hits);
  }
  return out;
}
