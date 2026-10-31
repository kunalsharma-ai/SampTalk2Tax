import { AccountType } from './accounts';
import { D, Dec, MoneyError, RATE_SCALE, assertCurrencyPrecision, dec, isSupportedCurrency, roundToCurrency, sum } from './money';

export const JOURNAL_TYPES = ['STANDARD', 'ADJUSTING', 'REVERSING', 'OPENING', 'CLOSING', 'RECURRING'] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export interface JournalLineInput {
  accountId: string;
  /** Decimal string in the line's transaction currency. Exactly one of debit/credit must be > 0. */
  debit?: string;
  credit?: string;
  /** ISO 4217 transaction currency; defaults to the functional currency. */
  currency?: string;
  /** Units of functional currency per 1 unit of transaction currency. Required when currency differs. */
  exchangeRate?: string;
  description?: string;
  dimensions?: Record<string, string>;
}

export interface PostingAccount {
  id: string;
  code: string;
  type: AccountType;
  isPostable: boolean;
  isActive: boolean;
}

export interface JournalValidationContext {
  functionalCurrency: string;
  accounts: ReadonlyMap<string, PostingAccount>;
}

export interface NormalizedJournalLine {
  lineNo: number;
  accountId: string;
  currency: string;
  exchangeRate: Dec;
  debit: Dec;
  credit: Dec;
  functionalDebit: Dec;
  functionalCredit: Dec;
  description?: string;
  dimensions?: Record<string, string>;
}

export interface NormalizedJournal {
  lines: NormalizedJournalLine[];
  totalFunctionalDebit: Dec;
  totalFunctionalCredit: Dec;
}

export class JournalValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Journal entry is invalid: ${issues.join('; ')}`);
    this.name = 'JournalValidationError';
  }
}

const MAX_LINES = 5000;

function parseAmount(raw: string | undefined, label: string, issues: string[]): Dec {
  if (raw === undefined || raw === null || raw === '') return new D(0);
  try {
    const v = dec(raw);
    if (v.isNegative()) {
      issues.push(`${label} must not be negative`);
      return new D(0);
    }
    return v;
  } catch (e) {
    issues.push(`${label}: ${(e as Error).message}`);
    return new D(0);
  }
}

/**
 * Validate and normalise journal lines. Enforces the core double-entry invariants:
 *  - at least two lines, each with exactly one positive side,
 *  - accounts exist, are active and postable,
 *  - currency precision and exchange-rate rules,
 *  - total functional debits equal total functional credits,
 *  - single-currency entries also balance in transaction currency.
 * Throws JournalValidationError listing every problem found.
 */
export function validateJournal(lines: readonly JournalLineInput[], ctx: JournalValidationContext): NormalizedJournal {
  const issues: string[] = [];
  if (!isSupportedCurrency(ctx.functionalCurrency)) {
    throw new JournalValidationError([`Unsupported functional currency ${ctx.functionalCurrency}`]);
  }
  if (!Array.isArray(lines) || lines.length < 2) issues.push('A journal entry needs at least two lines');
  if (lines.length > MAX_LINES) issues.push(`A journal entry may have at most ${MAX_LINES} lines`);

  const normalized: NormalizedJournalLine[] = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    const label = `Line ${n}`;
    const account = ctx.accounts.get(line.accountId);
    if (!account) issues.push(`${label}: account not found`);
    else {
      if (!account.isActive) issues.push(`${label}: account ${account.code} is inactive`);
      if (!account.isPostable) issues.push(`${label}: account ${account.code} is a header account and cannot be posted to`);
    }

    const currency = (line.currency ?? ctx.functionalCurrency).toUpperCase();
    if (!isSupportedCurrency(currency)) {
      issues.push(`${label}: unsupported currency ${currency}`);
      return;
    }

    const debit = parseAmount(line.debit, `${label} debit`, issues);
    const credit = parseAmount(line.credit, `${label} credit`, issues);
    if (debit.isZero() && credit.isZero()) issues.push(`${label}: either debit or credit must be greater than zero`);
    if (!debit.isZero() && !credit.isZero()) issues.push(`${label}: a line cannot have both a debit and a credit`);
    try {
      assertCurrencyPrecision(debit, currency, `${label} debit`);
      assertCurrencyPrecision(credit, currency, `${label} credit`);
    } catch (e) {
      issues.push((e as MoneyError).message);
    }

    let rate = new D(1);
    if (currency === ctx.functionalCurrency) {
      if (line.exchangeRate !== undefined) {
        let ok = false;
        try {
          ok = dec(line.exchangeRate).equals(1);
        } catch {
          ok = false;
        }
        if (!ok) issues.push(`${label}: exchange rate must be 1 when the line is in the functional currency`);
      }
    } else if (line.exchangeRate === undefined) {
      issues.push(`${label}: exchange rate is required for ${currency} (functional currency is ${ctx.functionalCurrency})`);
    } else {
      try {
        rate = dec(line.exchangeRate);
        if (!rate.isPositive()) issues.push(`${label}: exchange rate must be positive`);
        if (rate.decimalPlaces() > RATE_SCALE) issues.push(`${label}: exchange rate supports at most ${RATE_SCALE} decimal places`);
      } catch (e) {
        issues.push(`${label}: ${(e as Error).message}`);
      }
    }

    normalized.push({
      lineNo: n,
      accountId: line.accountId,
      currency,
      exchangeRate: rate,
      debit,
      credit,
      functionalDebit: roundToCurrency(debit.times(rate), ctx.functionalCurrency),
      functionalCredit: roundToCurrency(credit.times(rate), ctx.functionalCurrency),
      description: line.description,
      dimensions: line.dimensions,
    });
  });

  const totalFunctionalDebit = sum(normalized.map((l) => l.functionalDebit));
  const totalFunctionalCredit = sum(normalized.map((l) => l.functionalCredit));

  if (issues.length === 0) {
    if (!totalFunctionalDebit.equals(totalFunctionalCredit)) {
      const diff = totalFunctionalDebit.minus(totalFunctionalCredit).abs();
      issues.push(
        `Entry does not balance: debits ${totalFunctionalDebit.toFixed()} vs credits ${totalFunctionalCredit.toFixed()} ${ctx.functionalCurrency} (difference ${diff.toFixed()}). ` +
          'If this is caused by currency conversion rounding, add an explicit rounding line.',
      );
    }
    const currencies = new Set(normalized.map((l) => l.currency));
    if (currencies.size === 1) {
      const d = sum(normalized.map((l) => l.debit));
      const c = sum(normalized.map((l) => l.credit));
      if (!d.equals(c)) issues.push(`Entry does not balance in transaction currency: ${d.toFixed()} vs ${c.toFixed()}`);
    }
  }

  if (issues.length) throw new JournalValidationError(issues);
  return { lines: normalized, totalFunctionalDebit, totalFunctionalCredit };
}

export interface PostedLineLike {
  accountId: string;
  currency: string;
  exchangeRate: string;
  debit: string;
  credit: string;
  description?: string | null;
  dimensions?: Record<string, string> | null;
}

/**
 * Build the lines of a reversing entry: every debit becomes a credit and vice versa,
 * at the original exchange rates, so the reversal nets the original to exactly zero
 * in both transaction and functional currency.
 */
export function buildReversalLines(original: readonly PostedLineLike[]): JournalLineInput[] {
  return original.map((l) => ({
    accountId: l.accountId,
    currency: l.currency,
    exchangeRate: l.exchangeRate,
    debit: l.credit,
    credit: l.debit,
    description: l.description ? `Reversal: ${l.description}` : 'Reversal',
    dimensions: l.dimensions ?? undefined,
  }));
}
