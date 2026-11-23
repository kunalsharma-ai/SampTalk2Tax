import { makePortalToken } from './customer-portal';
import { type Dec, dec, minorUnits } from './money';

/**
 * Bank feeds (BANK-004). A feed connection links one bank account in the books to something that
 * sends its transactions as they happen: a bank's host-to-host channel, an account aggregator
 * partner, a treasury system or a script. The sender authenticates with a secret token made for
 * that one connection and posts either
 * - TRANSACTIONS: JSON transactions, each with the sender's own id, so sending the same
 *   transaction again never adds it twice; or
 * - STATEMENT_FILE: an OFX, QIF or MT940 statement file, deduplicated like an uploaded file.
 * Every delivery is recorded with what came in, what was added, what was already there and what
 * was refused and why. Lines arrive unmatched and are reconciled like imported ones.
 */
export const BANK_FEED_KINDS = ['TRANSACTIONS', 'STATEMENT_FILE'] as const;
export type BankFeedKind = (typeof BANK_FEED_KINDS)[number];

export const BANK_FEED_TOKEN_PATTERN = /^t2tf_[A-Za-z0-9]{40}$/;
export const makeBankFeedToken = (random: (n: number) => Uint8Array) => `t2tf_${makePortalToken(random).slice(5)}`;
export const bankFeedTokenPrefix = (token: string) => token.slice(5, 13);

/** How often a feed is expected to send something, in hours. A quiet feed past this shows as late. */
export const BANK_FEED_EXPECT_HOURS = [1, 6, 24, 72, 168] as const;
/** The most transactions one delivery may carry. */
export const BANK_FEED_MAX_TRANSACTIONS = 1000;
const EARLIEST = '2000-01-01';

export interface BankFeedLine {
  externalId: string;
  date: string;
  description: string;
  reference: string | null;
  /** Positive is money in, negative is money out. */
  amount: Dec;
}

export interface BankFeedRejection {
  /** Position in the delivery, from 1. */
  position: number;
  id: string | null;
  reasons: string[];
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money

/**
 * Checks the transactions of one delivery. Amounts must be strings (never JSON numbers, which can
 * lose pennies), either signed or unsigned with direction CREDIT (in) or DEBIT (out), with no
 * more decimals than the account's currency has. A transaction dated after tomorrow is refused
 * (a feed reports what happened, and tomorrow allows for time zones). The same id twice in one
 * delivery keeps the first.
 */
export function normaliseFeedTransactions(input: readonly unknown[], opts: { currency: string; today: string }): { lines: BankFeedLine[]; rejected: BankFeedRejection[] } {
  const lines: BankFeedLine[] = [];
  const rejected: BankFeedRejection[] = [];
  const scale = minorUnits(opts.currency);
  const amountShape = scale === 0 ? /^-?\d{1,15}$/ : new RegExp(`^-?\\d{1,15}(\\.\\d{1,${scale}})?$`);
  const latest = addDays(opts.today, 1);
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    const position = i + 1; // not money
    const reasons: string[] = [];
    const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!t) {
      rejected.push({ position, id: null, reasons: ['not an object'] });
      return;
    }
    const id = text(t.id);
    if (!id) reasons.push('no id');
    else if (id.length > 100) reasons.push('id longer than 100 characters');
    else if (seen.has(id)) reasons.push('the same id appears earlier in this delivery');
    const date = text(t.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) reasons.push(`date "${String(t.date ?? '')}" (use YYYY-MM-DD)`);
    else if (date < EARLIEST) reasons.push('dated before 2000');
    else if (date > latest) reasons.push('dated in the future');
    let amount: Dec | null = null;
    if (typeof t.amount === 'number') reasons.push('amount sent as a number; send it as a string, like "1250.00"');
    else {
      const a = text(t.amount).replace(/,/g, '');
      if (!amountShape.test(a)) reasons.push(`amount "${String(t.amount ?? '')}"${scale === 0 ? ' (no decimals in this currency)' : ` (at most ${scale} decimals)`}`);
      else if (dec(a).isZero()) reasons.push('amount is zero');
      else {
        amount = dec(a);
        const direction = t.direction == null ? '' : text(t.direction).toUpperCase();
        if (direction && direction !== 'CREDIT' && direction !== 'DEBIT') reasons.push(`direction "${String(t.direction)}" (use CREDIT or DEBIT)`);
        else if (direction && amount.isNegative()) reasons.push('a direction with a negative amount; send one or the other');
        else if (direction === 'DEBIT') amount = amount.negated();
      }
    }
    const description = text(t.description).replace(/\s+/g, ' ');
    if (!description) reasons.push('no description');
    else if (description.length > 500) reasons.push('description longer than 500 characters');
    const reference = text(t.reference) || null;
    if (reference && reference.length > 100) reasons.push('reference longer than 100 characters');
    if (t.currency != null && text(t.currency).toUpperCase() !== opts.currency) reasons.push(`currency ${String(t.currency)}; this account is in ${opts.currency}`);
    if (id && id.length <= 100) seen.add(id);
    if (reasons.length || !amount) rejected.push({ position, id: id || null, reasons });
    else lines.push({ externalId: id, date, description, reference, amount });
  });
  return { lines, rejected };
}

/** The key that makes a fed transaction unique on its account: the sender's own id. */
export const bankFeedLineKey = (accountId: string, externalId: string) => ['feed', accountId, externalId].join('\u0001');

export const BANK_FEED_OUTCOMES = ['IMPORTED', 'NOTHING_NEW', 'REJECTED', 'FAILED'] as const;
export type BankFeedOutcome = (typeof BANK_FEED_OUTCOMES)[number];

/** What a delivery came to: anything added is IMPORTED; nothing new but nothing wrong is NOTHING_NEW. */
export function bankFeedOutcome(r: { imported: number; duplicates: number; rejected: number }): BankFeedOutcome {
  if (r.imported > 0) return 'IMPORTED';
  if (r.rejected > 0) return 'REJECTED';
  return 'NOTHING_NEW';
}

export type BankFeedHealth = 'HEALTHY' | 'LATE' | 'FAILING' | 'WAITING' | 'PAUSED' | 'REVOKED';

export interface BankFeedState {
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  createdAt: Date;
  expectEveryHours: number;
  /** The last delivery of any outcome. */
  lastDeliveryAt: Date | null;
  lastOutcome: BankFeedOutcome | null;
  /** The last delivery that was accepted (IMPORTED or NOTHING_NEW). */
  lastAcceptedAt: Date | null;
}

/**
 * How a feed is doing, for the list and the alerts: FAILING when its last delivery was refused,
 * WAITING before anything arrived (LATE if that is past the expected interval), LATE when nothing
 * was accepted within the expected interval, otherwise HEALTHY.
 */
export function bankFeedHealth(c: BankFeedState, now: Date): { health: BankFeedHealth; message: string } {
  if (c.status === 'REVOKED') return { health: 'REVOKED', message: 'Disconnected; its token no longer works' };
  if (c.status === 'PAUSED') return { health: 'PAUSED', message: 'Paused; deliveries are refused until it is resumed' };
  const hours = (d: Date) => (now.getTime() - d.getTime()) / 3_600_000; // not money
  if (c.lastOutcome === 'REJECTED' || c.lastOutcome === 'FAILED') return { health: 'FAILING', message: 'The last delivery was refused; see its reasons below' };
  if (!c.lastAcceptedAt) {
    return hours(c.createdAt) > c.expectEveryHours
      ? { health: 'LATE', message: `Nothing has arrived since it was set up ${Math.floor(hours(c.createdAt))} hours ago` }
      : { health: 'WAITING', message: 'Waiting for the first delivery' };
  }
  const since = hours(c.lastAcceptedAt);
  if (since > c.expectEveryHours) return { health: 'LATE', message: `Nothing for ${Math.floor(since)} hours; expected every ${c.expectEveryHours}` };
  return { health: 'HEALTHY', message: 'Delivering as expected' };
}
