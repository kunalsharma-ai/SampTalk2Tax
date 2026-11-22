/**
 * Reconciliation exception analysis (BANK-020): why bank statement lines and entries in the books
 * are still unmatched on an account, and what to do about each. Deterministic: every exception
 * says what it was found on. Amounts are decimal strings; positive is money in.
 *
 * Exceptions are found in this order, and an item is used once:
 * 1. AMOUNT_DIFFERS: a statement line and an entry the same way, within 7 days, whose amounts
 *    differ by no more than 2% (a fee taken off, a short payment). Closest pairs first.
 * 2. SPLIT: one item equal to two or three on the other side, the same way, within 7 days (two
 *    cheques banked together, a payment made in parts).
 * 3. REVERSED: two statement lines, or two entries, for the same amount in and out within 7 days,
 *    which cancel out (a returned payment, a reversed entry).
 * 4. BANK_CHARGES: a statement line whose narration reads like a charge, fee, tax on one, or
 *    interest, with nothing in the books.
 * 5. NOT_IN_BOOKS: any other statement line with nothing in the books.
 * 6. IN_TRANSIT: an entry dated within 7 days before the latest statement line, or after it:
 *    likely to clear on the next statement.
 * 7. STALE: an entry more than 30 days older than the latest statement line and still on no
 *    statement: a cheque not presented, or an entry on the wrong account.
 * 8. OUTSTANDING: any other entry not yet on a statement.
 */
import { daysBetween } from './documents';
import { D } from './money';
import { formatDateText } from './workflows';

export const RECON_EXCEPTION_KINDS = ['AMOUNT_DIFFERS', 'SPLIT', 'REVERSED', 'BANK_CHARGES', 'NOT_IN_BOOKS', 'STALE', 'IN_TRANSIT', 'OUTSTANDING'] as const;
export type ReconExceptionKind = (typeof RECON_EXCEPTION_KINDS)[number];
export const RECON_EXCEPTION_LABEL: Record<ReconExceptionKind, string> = {
  AMOUNT_DIFFERS: 'Amounts differ',
  SPLIT: 'Split or combined',
  REVERSED: 'Reversed',
  BANK_CHARGES: 'Bank charges or interest',
  NOT_IN_BOOKS: 'Not in the books',
  STALE: 'Old, not on any statement',
  IN_TRANSIT: 'In transit',
  OUTSTANDING: 'Not on the statement yet',
};
export const RECON_EXCEPTION_ACTION: Record<ReconExceptionKind, string> = {
  AMOUNT_DIFFERS: 'Match them, and book the difference (a bank fee or a short payment) with an entry',
  SPLIT: 'Match them together',
  REVERSED: 'They cancel out: exclude both statement lines, or leave both entries, saying why',
  BANK_CHARGES: 'Create an entry to bank charges or interest from the line',
  NOT_IN_BOOKS: 'Record the receipt or payment, or create an entry from the line',
  STALE: 'Find out why it never reached the bank: void or reissue a cheque, or move the entry to the right account',
  IN_TRANSIT: 'Nothing yet: it should clear on the next statement',
  OUTSTANDING: 'Check it reaches the bank; match it when it shows on a statement',
};

export const RECON_PAIR_DAYS = 7;
export const RECON_AMOUNT_TOLERANCE = '0.02';
export const RECON_TRANSIT_DAYS = 7;
export const RECON_STALE_DAYS = 30;
const CHARGE_WORDS = /\b(charges?|chrgs?|chg|fee|fees|commission|comm|sms|maint|maintenance|penal|penalty|gst|interest|int\.?\s?(pd|paid|cr|credit)|cr\s?int|debit card annual)\b/i;

export interface ReconItem {
  id: string;
  date: string;
  /** Positive is money in. */
  amount: string;
  text: string;
}

export interface ReconException {
  kind: ReconExceptionKind;
  label: string;
  action: string;
  statement: ReconItem[];
  book: ReconItem[];
  /** The money involved: the statement side when there is one, otherwise the books'; for REVERSED, the amount that went in. */
  amount: string;
  /** Statement less books, for AMOUNT_DIFFERS. */
  difference: string | null;
  /** Days from the oldest item's date to `asOf`. */
  age: number;
  detail: string;
}

export interface ReconExceptionSummary {
  kind: ReconExceptionKind;
  label: string;
  count: number;
  amount: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sameWay = (a: ReconItem, b: ReconItem) => new D(a.amount).isNeg() === new D(b.amount).isNeg();
const near = (a: ReconItem, b: ReconItem, days = RECON_PAIR_DAYS) => Math.abs(daysBetween(a.date, b.date)) <= days;
const sum = (xs: ReconItem[]) => xs.reduce((s, x) => s.plus(x.amount), new D(0));

/** Ages of unmatched items: up to 7 days, 8 to 30, 31 to 90, over 90. */
export function reconAgeing(items: ReconItem[], asOf: string, scale: number) {
  const buckets = [
    { label: 'Up to 7 days', max: 7 },
    { label: '8 to 30 days', max: 30 },
    { label: '31 to 90 days', max: 90 },
    { label: 'Over 90 days', max: Infinity },
  ].map((b) => ({ label: b.label, max: b.max, count: 0, amount: new D(0) }));
  for (const i of items) {
    const b = buckets.find((x) => daysBetween(i.date, asOf) <= x.max)!;
    b.count++;
    b.amount = b.amount.plus(new D(i.amount).abs());
  }
  return buckets.map((b) => ({ label: b.label, count: b.count, amount: b.amount.toFixed(scale) }));
}

/** Combinations of two or three items that add up to `target`, the same way and near `anchor`. */
function findParts(target: ReconItem, pool: ReconItem[]): ReconItem[] | null {
  const c = pool.filter((p) => sameWay(p, target) && near(p, target) && new D(p.amount).abs().lt(new D(target.amount).abs()));
  const want = new D(target.amount);
  for (let i = 0; i < c.length; i++)
    for (let j = i + 1; j < c.length; j++) {
      if (sum([c[i]!, c[j]!]).eq(want)) return [c[i]!, c[j]!];
      for (let k = j + 1; k < c.length; k++) if (sum([c[i]!, c[j]!, c[k]!]).eq(want)) return [c[i]!, c[j]!, c[k]!];
    }
  return null;
}

/**
 * Every unmatched item on one account, grouped into exceptions with a suggested action.
 * `statement` are unmatched statement lines (not excluded), `book` unmatched entries on the account,
 * and `lastStatementDate` the date of the latest statement line imported.
 */
export function reconciliationExceptions(statement: ReconItem[], book: ReconItem[], lastStatementDate: string | null, asOf: string, scale: number) {
  const usedS = new Set<string>();
  const usedB = new Set<string>();
  const out: ReconException[] = [];
  const money = (x: InstanceType<typeof D> | string) => new D(x).toFixed(scale);
  const push = (kind: ReconExceptionKind, s: ReconItem[], b: ReconItem[], detail: string, difference: string | null = null, amount?: string) => {
    for (const x of s) usedS.add(x.id);
    for (const x of b) usedB.add(x.id);
    const oldest = [...s, ...b].map((x) => x.date).sort()[0]!;
    out.push({ kind, label: RECON_EXCEPTION_LABEL[kind], action: RECON_EXCEPTION_ACTION[kind], statement: s, book: b, amount: amount ?? money(s.length ? sum(s) : sum(b)), difference, age: daysBetween(oldest, asOf), detail });
  };
  const freeS = () => statement.filter((x) => !usedS.has(x.id));
  const freeB = () => book.filter((x) => !usedB.has(x.id));

  // 1. Amounts that differ a little.
  const pairs: { s: ReconItem; b: ReconItem; gap: InstanceType<typeof D> }[] = [];
  for (const s of statement)
    for (const b of book) {
      if (!sameWay(s, b) || !near(s, b)) continue;
      const gap = new D(s.amount).minus(b.amount).abs();
      if (gap.gt(0) && gap.lte(new D(b.amount).abs().times(RECON_AMOUNT_TOLERANCE))) pairs.push({ s, b, gap });
    }
  pairs.sort((x, y) => x.gap.cmp(y.gap) || Math.abs(daysBetween(x.s.date, x.b.date)) - Math.abs(daysBetween(y.s.date, y.b.date)));
  for (const p of pairs) {
    if (usedS.has(p.s.id) || usedB.has(p.b.id)) continue;
    const diff = new D(p.s.amount).minus(p.b.amount);
    push('AMOUNT_DIFFERS', [p.s], [p.b], `The bank shows ${money(p.s.amount)} and the books ${money(p.b.amount)}: ${money(diff.abs())} ${diff.lt(0) ? 'less' : 'more'} at the bank`, money(diff));
  }

  // 2. One item against two or three on the other side.
  for (const b of freeB()) {
    const parts = findParts(b, freeS());
    if (parts) push('SPLIT', parts, [b], `${plural(parts.length, 'statement line')} add up to one entry of ${money(b.amount)}`);
  }
  for (const s of freeS()) {
    const parts = findParts(s, freeB());
    if (parts) push('SPLIT', [s], parts, `${plural(parts.length, 'entry', 'entries')} in the books add up to one statement line of ${money(s.amount)}`);
  }

  // 3. In and out again.
  for (const side of ['statement', 'book'] as const) {
    const pool = side === 'statement' ? freeS() : freeB();
    const used = side === 'statement' ? usedS : usedB;
    for (const a of pool) {
      if (used.has(a.id)) continue;
      const back = pool.find((x) => x.id !== a.id && !used.has(x.id) && new D(x.amount).plus(a.amount).isZero() && near(a, x));
      if (!back) continue;
      const pair = [a, back].sort((x, y) => x.date.localeCompare(y.date));
      const size = money(new D(a.amount).abs());
      const when = `${formatDateText(pair[0]!.date)} and ${formatDateText(pair[1]!.date)}`;
      if (side === 'statement') push('REVERSED', pair, [], `${size} in and out again on the statement, ${when}`, null, size);
      else push('REVERSED', [], pair, `${size} in and out again in the books, ${when}`, null, size);
    }
  }

  // 4–5. Statement lines with nothing in the books.
  for (const s of freeS()) {
    const age = daysBetween(s.date, asOf);
    if (CHARGE_WORDS.test(s.text)) push('BANK_CHARGES', [s], [], `"${s.text}" reads like a bank charge or interest, and is not in the books`);
    else push('NOT_IN_BOOKS', [s], [], `${new D(s.amount).lt(0) ? 'Money out' : 'Money in'} at the bank ${age} days ago with nothing in the books`);
  }

  // 6–8. Entries not on any statement.
  for (const b of freeB()) {
    if (!lastStatementDate) {
      push('OUTSTANDING', [], [b], 'No statement has been imported for this account yet');
      continue;
    }
    const behind = daysBetween(b.date, lastStatementDate);
    if (behind <= RECON_TRANSIT_DAYS) push('IN_TRANSIT', [], [b], behind < 0 ? `Dated after the latest statement line (${formatDateText(lastStatementDate)})` : `Dated ${plural(behind, 'day')} before the latest statement line (${formatDateText(lastStatementDate)})`);
    else if (behind > RECON_STALE_DAYS) push('STALE', [], [b], `${behind} days older than the latest statement line and still on no statement`);
    else push('OUTSTANDING', [], [b], `${behind} days older than the latest statement line`);
  }

  const order = (k: ReconExceptionKind) => RECON_EXCEPTION_KINDS.indexOf(k);
  out.sort((a, b) => order(a.kind) - order(b.kind) || b.age - a.age);
  const summary: ReconExceptionSummary[] = RECON_EXCEPTION_KINDS.map((kind) => {
    const xs = out.filter((x) => x.kind === kind);
    return { kind, label: RECON_EXCEPTION_LABEL[kind], count: xs.length, amount: money(xs.reduce((s, x) => s.plus(new D(x.amount).abs()), new D(0))) };
  });
  return {
    exceptions: out,
    summary,
    ageing: { statement: reconAgeing(statement, asOf, scale), book: reconAgeing(book, asOf, scale) },
    unmatched: { statement: statement.length, book: book.length },
  };
}

