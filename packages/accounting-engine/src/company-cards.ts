import { makePortalToken } from './customer-portal';
import type { JournalLineInput } from './journal';
import { D, type Dec, minorUnits } from './money';

/**
 * Company cards (EXP-011 corporate cards, EXP-012 virtual cards). The architecture is
 * provider-agnostic: a card programme is one card provider's account with the organisation,
 * paid through one liability account in the books, and the provider talks to Talk2Tax with a
 * secret token made for that programme:
 * - it reads the cards and the controls set here (holder, monthly limit, frozen or cancelled),
 *   so the provider enforces what finance decided;
 * - it confirms a virtual card the organisation asked for (its last four digits and expiry;
 *   full card numbers never reach Talk2Tax);
 * - it sends card transactions, each with its own id, so sending one again never adds it twice,
 *   and a settled transaction replaces the authorisation it settles.
 * Cardholders explain their spending (account and note); finance posts it to the books (debit
 * the expense, credit the card account). Spending that matches an expense claim line by the same
 * person (same amount, within three days) is shown as possibly claimed twice.
 *
 * No framework or database code.
 */

export const CARD_KINDS = ['CORPORATE', 'VIRTUAL'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CARD_STATUSES = ['REQUESTED', 'ACTIVE', 'FROZEN', 'CANCELLED'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_FEED_TOKEN_PATTERN = /^t2tc_[A-Za-z0-9]{40}$/;
export const makeCardFeedToken = (random: (n: number) => Uint8Array) => `t2tc_${makePortalToken(random).slice(5)}`;
export const cardFeedTokenPrefix = (token: string) => token.slice(5, 13);
/** The most transactions one delivery may carry. */
export const CARD_FEED_MAX_TRANSACTIONS = 1000;
/** How far apart, in days, a card transaction and an expense claim line may be dated and still look like the same spending. */
export const CARD_CLAIM_MATCH_DAYS = 3;

export interface FeedCard {
  id: string;
  last4: string | null;
  providerRef: string | null;
  status: CardStatus;
}

export interface CardFeedLine {
  externalId: string;
  cardId: string;
  date: string;
  /** Positive is spending, negative a refund, in the programme's currency. */
  amount: Dec;
  merchant: string;
  /** Merchant category code, four digits. */
  mcc: string | null;
  state: 'AUTHORISED' | 'SETTLED';
}
export interface CardFeedRejection {
  position: number;
  id: string | null;
  reasons: string[];
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000; // not money

/**
 * Checks one delivery of card transactions. Each names its card by the provider's reference or
 * the card's last four digits (when only one card in the programme has them). Amounts are
 * strings with no more decimals than the currency has, positive for spending and negative for a
 * refund, and in the programme's currency (the provider converts foreign spending). Transactions
 * on a card that was only requested, or dated after tomorrow, are refused.
 */
export function normaliseCardTransactions(input: readonly unknown[], opts: { currency: string; today: string; cards: readonly FeedCard[] }): { lines: CardFeedLine[]; rejected: CardFeedRejection[] } {
  const lines: CardFeedLine[] = [];
  const rejected: CardFeedRejection[] = [];
  const scale = minorUnits(opts.currency);
  const amountShape = scale === 0 ? /^-?\d{1,13}$/ : new RegExp(`^-?\\d{1,13}(\\.\\d{1,${scale}})?$`);
  const latest = addDays(opts.today, 1);
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    const position = i + 1; // not money
    const reasons: string[] = [];
    const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!t) return void rejected.push({ position, id: null, reasons: ['not an object'] });
    const id = text(t.id);
    if (!id) reasons.push('no id');
    else if (id.length > 100) reasons.push('id longer than 100 characters');
    else if (seen.has(id)) reasons.push('the same id appears earlier in this delivery');
    const ref = text(t.card);
    let card: FeedCard | undefined;
    if (!ref) reasons.push('no card (send the card reference or its last four digits)');
    else {
      card = opts.cards.find((c) => c.providerRef !== null && c.providerRef === ref) ?? opts.cards.find((c) => c.id === ref);
      if (!card && /^\d{4}$/.test(ref)) {
        const by4 = opts.cards.filter((c) => c.last4 === ref && c.status !== 'REQUESTED');
        if (by4.length > 1) reasons.push(`more than one card ends in ${ref}; send the card reference`);
        else card = by4[0];
      }
      if (!card && !reasons.length) reasons.push(`no card "${ref.slice(0, 40)}" in this programme`);
      else if (card?.status === 'REQUESTED') reasons.push('the card has not been issued yet');
    }
    const date = text(t.date);
    if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) reasons.push(`date "${String(t.date ?? '').slice(0, 20)}" (use YYYY-MM-DD)`);
    else if (date < '2000-01-01') reasons.push('dated before 2000');
    else if (date > latest) reasons.push('dated in the future');
    let amount: Dec | null = null;
    if (typeof t.amount === 'number') reasons.push('amount sent as a number; send it as a string, like "1250.00"');
    else {
      const a = text(t.amount);
      if (!amountShape.test(a)) reasons.push(`amount "${a.slice(0, 20)}" (at most ${scale} decimals)`);
      else if (new D(a).isZero()) reasons.push('amount is zero');
      else amount = new D(a);
    }
    const currency = text(t.currency).toUpperCase();
    if (currency && currency !== opts.currency) reasons.push(`currency ${currency.slice(0, 3)}; this programme is in ${opts.currency} (send the converted amount)`);
    const merchant = text(t.merchant);
    if (!merchant) reasons.push('no merchant');
    const mcc = text(t.mcc);
    if (mcc && !/^\d{4}$/.test(mcc)) reasons.push('mcc must be four digits');
    const state = text(t.state).toUpperCase() || 'SETTLED';
    if (state !== 'AUTHORISED' && state !== 'SETTLED') reasons.push('state must be AUTHORISED or SETTLED');
    if (reasons.length) return void rejected.push({ position, id: id || null, reasons });
    seen.add(id);
    lines.push({ externalId: id, cardId: card!.id, date, amount: amount!, merchant: merchant.slice(0, 120), mcc: mcc || null, state: state as CardFeedLine['state'] });
  });
  return { lines, rejected };
}

/** How a card stands against its monthly limit: spending this calendar month, what is left, and whether it is over. */
export function cardLimitStatus(limit: string | null, spent: string) {
  const s = new D(spent);
  if (limit === null) return { limit: null, spent: s.toFixed(2), remaining: null, usedPercent: null, over: false };
  const l = new D(limit);
  return { limit: l.toFixed(2), spent: s.toFixed(2), remaining: D.max(0, l.minus(s)).toFixed(2), usedPercent: l.isZero() ? null : s.dividedBy(l).times(100).toDecimalPlaces(0).toNumber(), over: s.greaterThan(l) };
}

export interface CardClaimLine {
  claimId: string;
  claimNumber: string;
  claimStatus: string;
  claimantId: string;
  lineNo: number;
  date: string;
  amount: string;
  merchant: string | null;
}
export interface CardClaimMatch {
  claimId: string;
  claimNumber: string;
  claimStatus: string;
  lineNo: number;
  date: string;
  merchant: string | null;
}

/**
 * Expense claim lines that look like the same spending as a card transaction: claimed by the
 * cardholder, for the same amount, dated within three days. Void and rejected claims are left
 * out (they will not be paid). Paying such a claim would pay the person back for something the
 * company's card already paid.
 */
export function cardClaimMatches(txn: { holderId: string; date: string; amount: string }, lines: readonly CardClaimLine[]): CardClaimMatch[] {
  if (new D(txn.amount).lessThanOrEqualTo(0)) return [];
  return lines
    .filter((l) => l.claimantId === txn.holderId && l.claimStatus !== 'VOID' && l.claimStatus !== 'REJECTED' && new D(l.amount).equals(txn.amount) && daysApart(l.date, txn.date) <= CARD_CLAIM_MATCH_DAYS)
    .sort((a, b) => daysApart(a.date, txn.date) - daysApart(b.date, txn.date) || a.claimNumber.localeCompare(b.claimNumber))
    .map((l) => ({ claimId: l.claimId, claimNumber: l.claimNumber, claimStatus: l.claimStatus, lineNo: l.lineNo, date: l.date, merchant: l.merchant }));
}

/** The journal for a card transaction: spending debits the expense and credits the card account; a refund the other way. */
export function cardJournalLines(t: { amount: string; merchant: string; note: string | null }, expenseAccountId: string, cardAccountId: string): JournalLineInput[] {
  const a = new D(t.amount);
  const abs = a.abs().toFixed(2);
  const description = `${t.merchant}${t.note ? ` · ${t.note}` : ''}`.slice(0, 200);
  return a.greaterThan(0)
    ? [
        { accountId: expenseAccountId, debit: abs, description },
        { accountId: cardAccountId, credit: abs, description },
      ]
    : [
        { accountId: cardAccountId, debit: abs, description },
        { accountId: expenseAccountId, credit: abs, description },
      ];
}
