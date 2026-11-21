/**
 * Unusual bank activity (BANK-019 suspicious transaction monitoring, BANK-023 alerts): warning
 * signs on the lines of imported bank statements, which show every movement on the account,
 * including ones nobody has booked. Deterministic and explainable: each indicator says what it was
 * raised on, no model or outside data is used, and amounts are decimal strings.
 *
 * Indicators, most serious first (excluded statement lines are left out):
 * - HIGH: DUPLICATE, another line on the account with the same amount and narration (ignoring
 *   numbers) within 3 days; JUST_UNDER, one of 3 or more movements the same way within 7 days each
 *   between 90% and 100% of the reporting threshold (50,000 by default), the pattern of splitting
 *   to stay under it; PASS_THROUGH, money out within 2 days of a credit of 1 lakh or more, at 95%
 *   to 100% of it.
 * - MEDIUM: LARGE, over three times the largest movement the same way in the 90 days before (with
 *   at least 5 to compare); NEW_PAYEE, 1 lakh or more out to a narration not seen on the account in
 *   the 180 days before (with at least 10 lines to compare); NOT_RECORDED, money out more than 14
 *   days ago still not matched to anything in the books.
 * - LOW: ROUND, 1 lakh or more in whole thousands.
 */
import { addDays, daysBetween } from './documents';
import { D } from './money';
import { formatDateText } from './workflows';

export const BANK_ACTIVITY_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type BankActivityLevel = (typeof BANK_ACTIVITY_LEVELS)[number];
export const BANK_ACTIVITY_INDICATORS = ['DUPLICATE', 'JUST_UNDER', 'PASS_THROUGH', 'LARGE', 'NEW_PAYEE', 'NOT_RECORDED', 'ROUND'] as const;
export type BankActivityCode = (typeof BANK_ACTIVITY_INDICATORS)[number];
export const BANK_ACTIVITY_LEVEL: Record<BankActivityCode, BankActivityLevel> = {
  DUPLICATE: 'HIGH',
  JUST_UNDER: 'HIGH',
  PASS_THROUGH: 'HIGH',
  LARGE: 'MEDIUM',
  NEW_PAYEE: 'MEDIUM',
  NOT_RECORDED: 'MEDIUM',
  ROUND: 'LOW',
};
export const BANK_ACTIVITY_LABEL: Record<BankActivityCode, string> = {
  DUPLICATE: 'Possible duplicate',
  JUST_UNDER: 'Just under the threshold',
  PASS_THROUGH: 'Straight in and out',
  LARGE: 'Unusually large',
  NEW_PAYEE: 'Large payment to a new payee',
  NOT_RECORDED: 'Not in the books',
  ROUND: 'Large round amount',
};

export const BANK_ACTIVITY_DUPLICATE_DAYS = 3;
export const BANK_ACTIVITY_SPLIT_DAYS = 7;
export const BANK_ACTIVITY_SPLIT_COUNT = 3;
export const BANK_ACTIVITY_THRESHOLD = '50000';
export const BANK_ACTIVITY_BIG = '100000';
export const BANK_ACTIVITY_PASS_DAYS = 2;
export const BANK_ACTIVITY_LARGE_MULTIPLE = 3;
export const BANK_ACTIVITY_NOT_RECORDED_DAYS = 14;

export interface BankActivityLine {
  id: string;
  accountId: string;
  date: string;
  /** Positive is money in, negative money out. */
  amount: string;
  description: string;
  /** Matched to something in the books. */
  matched: boolean;
}

export interface BankActivityIndicator {
  code: BankActivityCode;
  level: BankActivityLevel;
  label: string;
  detail: string;
}

export interface BankActivityFinding {
  line: BankActivityLine;
  level: BankActivityLevel;
  indicators: BankActivityIndicator[];
}

/** A narration with case, numbers and punctuation taken away, for comparing payees. */
export function normaliseNarration(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ORDER: Record<BankActivityLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Statement lines dated in the `days` up to `asOf` with at least one indicator, most serious and
 * newest first. `lines` should hold the account's lines for the year before as well, to compare
 * with. `money` formats an amount in an account's currency for the details.
 */
export function unusualBankActivity(lines: BankActivityLine[], asOf: string, money: (amount: string, accountId: string) => string, opts: { days?: number; threshold?: string } = {}): BankActivityFinding[] {
  const from = addDays(asOf, -(opts.days ?? 30));
  const threshold = new D(opts.threshold ?? BANK_ACTIVITY_THRESHOLD);
  const big = new D(BANK_ACTIVITY_BIG);
  const byAccount = new Map<string, BankActivityLine[]>();
  for (const l of lines) byAccount.set(l.accountId, [...(byAccount.get(l.accountId) ?? []), l]);
  const out: BankActivityFinding[] = [];

  for (const all of byAccount.values()) {
    all.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const name = new Map(all.map((l) => [l.id, normaliseNarration(l.description)]));
    for (const l of all) {
      if (l.date < from || l.date > asOf) continue;
      const amount = new D(l.amount);
      const size = amount.abs();
      const isOut = amount.lt(0);
      const way = (o: BankActivityLine) => new D(o.amount).lt(0) === isOut;
      const indicators: BankActivityIndicator[] = [];
      const add = (code: BankActivityCode, detail: string) => indicators.push({ code, level: BANK_ACTIVITY_LEVEL[code], label: BANK_ACTIVITY_LABEL[code], detail });

      const dupes = all.filter((o) => o.id !== l.id && new D(o.amount).eq(amount) && name.get(o.id) === name.get(l.id) && Math.abs(daysBetween(o.date, l.date)) <= BANK_ACTIVITY_DUPLICATE_DAYS);
      if (dupes.length) add('DUPLICATE', `Same amount and narration as the line of ${dupes.map((o) => formatDateText(o.date)).join(', ')}`);

      const under = (o: BankActivityLine) => {
        const s = new D(o.amount).abs();
        return s.lt(threshold) && s.gte(threshold.times('0.9'));
      };
      if (under(l)) {
        // Movements the same way just under the threshold in any 7-day span that holds this one.
        let most = 0;
        for (let start = -BANK_ACTIVITY_SPLIT_DAYS + 1; start <= 0; start++) {
          const a = addDays(l.date, start);
          const b = addDays(a, BANK_ACTIVITY_SPLIT_DAYS - 1);
          most = Math.max(most, all.filter((o) => way(o) && under(o) && o.date >= a && o.date <= b).length);
        }
        if (most >= BANK_ACTIVITY_SPLIT_COUNT) add('JUST_UNDER', `One of ${most} ${isOut ? 'payments' : 'credits'} within ${BANK_ACTIVITY_SPLIT_DAYS} days each just under ${money(threshold.toFixed(), l.accountId)}`);
      }

      if (isOut) {
        const source = all.find((o) => {
          const credit = new D(o.amount);
          const gap = daysBetween(o.date, l.date);
          return credit.gte(big) && gap >= 0 && gap <= BANK_ACTIVITY_PASS_DAYS && size.lte(credit) && size.gte(credit.times('0.95'));
        });
        if (source) add('PASS_THROUGH', `Paid out ${daysBetween(source.date, l.date) === 0 ? 'the same day' : `${plural(daysBetween(source.date, l.date), 'day')} after`} ${money(source.amount, l.accountId)} came in`);
      }

      const before90 = all.filter((o) => o.id !== l.id && way(o) && o.date < l.date && o.date >= addDays(l.date, -90));
      if (before90.length >= 5) {
        const largest = before90.reduce((m, o) => D.max(m, new D(o.amount).abs()), new D(0));
        if (largest.gt(0) && size.gt(largest.times(BANK_ACTIVITY_LARGE_MULTIPLE))) add('LARGE', `Over ${BANK_ACTIVITY_LARGE_MULTIPLE} times the largest ${isOut ? 'payment' : 'credit'} on this account in the 90 days before (${money(largest.toFixed(), l.accountId)})`);
      }

      if (isOut && size.gte(big)) {
        const before180 = all.filter((o) => o.id !== l.id && o.date < l.date && o.date >= addDays(l.date, -180));
        if (before180.length >= 10 && name.get(l.id) && !before180.some((o) => name.get(o.id) === name.get(l.id))) add('NEW_PAYEE', 'Nothing with this narration on the account in the 180 days before');
      }

      const age = daysBetween(l.date, asOf);
      if (isOut && !l.matched && age > BANK_ACTIVITY_NOT_RECORDED_DAYS) add('NOT_RECORDED', `Left the bank ${age} days ago and still not matched to anything in the books`);

      if (size.gte(big) && size.mod(1000).isZero()) add('ROUND', `A large round amount (${money(size.toFixed(), l.accountId)})`);

      if (indicators.length) {
        indicators.sort((a, b) => ORDER[a.level] - ORDER[b.level] || BANK_ACTIVITY_INDICATORS.indexOf(a.code) - BANK_ACTIVITY_INDICATORS.indexOf(b.code));
        out.push({ line: l, level: indicators[0]!.level, indicators });
      }
    }
  }
  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level] || b.line.date.localeCompare(a.line.date) || a.line.id.localeCompare(b.line.id));
}
