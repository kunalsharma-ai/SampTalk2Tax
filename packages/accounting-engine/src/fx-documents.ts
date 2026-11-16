import type { JournalLineInput } from './journal';
import { D, Dec, dec, roundToCurrency, sum } from './money';

/**
 * Invoices, bills, credit notes, receipts and payments in a currency other than the
 * organisation's functional currency.
 *
 * A document or payment keeps one exchange rate (functional units per one unit of its
 * currency), fixed when it is saved. Its journal lines are in its own currency at that rate,
 * so the receivable or payable is carried at the document's rate.
 *
 * When a receipt (or credit note) settles an invoice at a different rate, the difference is a
 * realised exchange gain or loss. It is posted when the allocation is made: the control account
 * is moved from the settling item's rate to the invoice's rate, in the document's currency, and
 * the functional difference goes to the exchange gain/loss account. Removing the allocation
 * reverses that journal. Every journal line keeps a positive amount in its own currency, so
 * period-end revaluation (fx.ts) sees settled items as fully settled.
 */

/** Functional amount of a foreign amount at a rate, rounded half to even like every journal line. */
export function toFunctional(amount: Dec, rate: Dec | string, functionalCurrency: string): Dec {
  return roundToCurrency(amount.times(typeof rate === 'string' ? dec(rate) : rate), functionalCurrency);
}

/**
 * Puts journal lines in a foreign currency at one rate. Because each line is rounded on its own,
 * the functional total can be off by a few minor units: that difference is posted to the
 * rounding account (the exchange gain/loss account) as one functional-currency line.
 */
export function atRate(lines: readonly JournalLineInput[], currency: string, rate: string, functionalCurrency: string, roundingAccountId: string | null): JournalLineInput[] {
  if (currency === functionalCurrency) return lines.map((l) => ({ ...l, currency }));
  const out: JournalLineInput[] = lines.map((l) => ({ ...l, currency, exchangeRate: rate }));
  const side = (l: JournalLineInput, k: 'debit' | 'credit') => (l[k] ? toFunctional(dec(l[k]!), rate, functionalCurrency) : new D(0));
  const diff = sum(out.map((l) => side(l, 'debit'))).minus(sum(out.map((l) => side(l, 'credit'))));
  if (!diff.isZero()) {
    if (!roundingAccountId) throw new Error('A rounding account is needed for this foreign-currency journal');
    out.push({
      accountId: roundingAccountId,
      currency: functionalCurrency,
      ...(diff.isPositive() ? { credit: diff.toFixed() } : { debit: diff.negated().toFixed() }),
      description: 'Currency rounding',
    });
  }
  return out;
}

export interface SettlementInput {
  /** SALES: an invoice settled by a receipt or credit note. PURCHASES: a bill settled by a payment or vendor credit. */
  ledger: 'SALES' | 'PURCHASES';
  amount: Dec;
  currency: string;
  /** The rate of the invoice or bill being settled. */
  targetRate: string;
  /** The rate of the receipt, payment or credit settling it. */
  sourceRate: string;
  controlAccountId: string;
  fxAccountId: string;
  functionalCurrency: string;
}

export interface Settlement {
  /** Positive = gain, negative = loss, in the functional currency. */
  gain: Dec;
  lines: JournalLineInput[] | null;
}

/**
 * The realised exchange difference when an amount of an invoice or bill is settled at another
 * rate, and the journal that records it (null when there is no difference).
 */
export function settlement(s: SettlementInput): Settlement {
  if (s.currency === s.functionalCurrency || dec(s.targetRate).equals(dec(s.sourceRate))) return { gain: new D(0), lines: null };
  const atTarget = toFunctional(s.amount, s.targetRate, s.functionalCurrency);
  const atSource = toFunctional(s.amount, s.sourceRate, s.functionalCurrency);
  // Sales: the receipt took atSource off the receivable, which carries atTarget. Getting more is a gain.
  // Purchases: the payment took atSource off the payable, which carries atTarget. Paying more is a loss.
  const gain = s.ledger === 'SALES' ? atSource.minus(atTarget) : atTarget.minus(atSource);
  if (gain.isZero()) return { gain, lines: null };
  const a = s.amount.toFixed();
  const sales = s.ledger === 'SALES';
  const lines: JournalLineInput[] = [
    // Undo the settling item at its rate, and settle at the document's rate.
    { accountId: s.controlAccountId, currency: s.currency, exchangeRate: s.sourceRate, ...(sales ? { debit: a } : { credit: a }), description: 'Settled amount at the payment rate' },
    { accountId: s.controlAccountId, currency: s.currency, exchangeRate: s.targetRate, ...(sales ? { credit: a } : { debit: a }), description: 'Settled amount at the document rate' },
    {
      accountId: s.fxAccountId,
      currency: s.functionalCurrency,
      ...(gain.isPositive() ? { credit: gain.toFixed() } : { debit: gain.negated().toFixed() }),
      description: gain.isPositive() ? 'Realised exchange gain' : 'Realised exchange loss',
    },
  ];
  return { gain, lines };
}

/**
 * What is still open on a foreign item, in the functional currency, as the books carry it: its
 * total at its rate less each allocation at the same rate (each rounded as it was posted).
 */
export function functionalOpen(total: Dec, allocations: readonly Dec[], rate: string, currency: string, functionalCurrency: string): Dec {
  if (currency === functionalCurrency) return total.minus(sum([...allocations]));
  return toFunctional(total, rate, functionalCurrency).minus(sum(allocations.map((a) => toFunctional(a, rate, functionalCurrency))));
}
