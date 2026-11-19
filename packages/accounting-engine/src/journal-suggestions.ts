import { addMonths } from './forecast-lab';
import { D, Dec, dec, minorUnits } from './money';

/**
 * Automated journal suggestions (GL-036). Two deterministic checks over the books, with no AI:
 *
 * * **Repeat:** a manual journal with the same accounts on the same sides was posted in each of
 *   the last three months but not in this one (posted or draft). The suggestion copies the most
 *   recent one, dated on the same day of this month.
 * * **Accrual:** an expense account had costs from bills, expenses, bank or manual entries in each
 *   of the last three months but none this month. The suggestion accrues the three months'
 *   average to an accrued liabilities account at the month end, to be reversed next month.
 *
 * A suggestion is only ever a draft journal for someone to check and post.
 */

export const SUGGESTION_LOOKBACK_MONTHS = 3;

/** Sources whose expense postings show a recurring cost that may need accruing. */
const ACCRUAL_SOURCES = new Set(['DOCUMENT', 'EXPENSE', 'BANK', 'PAYMENT', 'MANUAL']);

export interface SuggestionJournal {
  id: string;
  entryNumber: number | null;
  date: string;
  source: string;
  type: string;
  status: 'POSTED' | 'DRAFT';
  isReversal: boolean;
  memo: string | null;
  /** Functional-currency amounts, as decimal strings. */
  lines: { accountId: string; debit: string; credit: string; description: string | null; departmentId?: string | null; projectId?: string | null }[];
}

export interface SuggestionAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  isActive: boolean;
  isPostable: boolean;
}

export interface JournalSuggestion {
  key: string;
  kind: 'REPEAT' | 'ACCRUAL';
  title: string;
  reason: string;
  date: string;
  memo: string;
  type: 'STANDARD' | 'ADJUSTING';
  total: string;
  /** The amount in each earlier month, oldest first. */
  history: { month: string; amount: string }[];
  basedOn: { id: string; entryNumber: number | null; date: string }[];
  lines: { accountId: string; debit: string; credit: string; description: string | null; departmentId?: string | null; projectId?: string | null }[];
}

export interface SuggestionResult {
  month: string;
  suggestions: JournalSuggestion[];
  notes: string[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthName(month: string): string {
  return `${MONTHS[+month.slice(5, 7) - 1]} ${month.slice(0, 4)}`;
}
export function lastDayOf(month: string): string {
  const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0));
  return `${month}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** A short stable key (FNV-1a, 32 bits) for a set of accounts and sides. */
function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function signature(lines: SuggestionJournal['lines']): string {
  return [...new Set(lines.filter((l) => !dec(l.debit).isZero() || !dec(l.credit).isZero()).map((l) => `${l.accountId}:${dec(l.debit).gt(0) ? 'D' : 'C'}`))].sort().join('|');
}

/** The suggestions for a month (YYYY-MM), given the journals of that month and the three before it. */
export function suggestJournals(input: { month: string; today: string; currency: string; journals: readonly SuggestionJournal[]; accounts: readonly SuggestionAccount[] }): SuggestionResult {
  const { month, today, currency } = input;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('The month is written YYYY-MM');
  const scale = minorUnits(currency);
  const notes: string[] = [];
  const suggestions: JournalSuggestion[] = [];
  if (month > today.slice(0, 7)) return { month, suggestions, notes: ['Suggestions are made for this month or earlier ones.'] };
  const earlier = Array.from({ length: SUGGESTION_LOOKBACK_MONTHS }, (_, i) => addMonths(month, i - SUGGESTION_LOOKBACK_MONTHS));
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const usable = (id: string) => {
    const a = byId.get(id);
    return !!a && a.isActive && a.isPostable;
  };
  const monthOf = (j: SuggestionJournal) => j.date.slice(0, 7);
  const thisMonth = input.journals.filter((j) => monthOf(j) === month && j.type !== 'CLOSING');

  // ---------------------------------------------------------------- repeats
  const manual = (j: SuggestionJournal) => j.source === 'MANUAL' && !j.isReversal && j.type !== 'CLOSING' && j.type !== 'OPENING';
  const groups = new Map<string, SuggestionJournal[]>();
  for (const j of input.journals) {
    if (!manual(j) || j.status !== 'POSTED' || !earlier.includes(monthOf(j))) continue;
    const sig = signature(j.lines);
    if (!sig) continue;
    groups.set(sig, [...(groups.get(sig) ?? []), j]);
  }
  const doneThisMonth = new Set(thisMonth.filter(manual).map((j) => signature(j.lines)));
  const repeatedAccounts = new Set<string>();
  for (const [sig, js] of groups) {
    const perMonth = earlier.map((m) => js.filter((j) => monthOf(j) === m));
    if (perMonth.some((x) => !x.length) || doneThisMonth.has(sig)) continue;
    const sorted = [...js].sort((a, b) => (a.date === b.date ? (a.entryNumber ?? 0) - (b.entryNumber ?? 0) : a.date < b.date ? -1 : 1));
    const latest = sorted[sorted.length - 1]!;
    if (!latest.lines.every((l) => usable(l.accountId))) continue;
    const day = Math.min(+latest.date.slice(8, 10), +lastDayOf(month).slice(8, 10));
    const date = `${month}-${String(day).padStart(2, '0')}`;
    if (date > today) continue;
    const totalOf = (j: SuggestionJournal) => j.lines.reduce((s, l) => s.plus(dec(l.debit)), new D(0));
    const history = perMonth.map((x, i) => ({ month: earlier[i]!, amount: x.reduce((s, j) => s.plus(totalOf(j)), new D(0)).toFixed(scale) }));
    const same = new Set(sorted.map((j) => totalOf(j).toFixed(scale))).size === 1;
    const names = [...new Set(latest.lines.map((l) => byId.get(l.accountId)?.name ?? ''))].filter(Boolean);
    for (const l of latest.lines) repeatedAccounts.add(l.accountId);
    suggestions.push({
      key: `REPEAT:${hashKey(sig)}`,
      kind: 'REPEAT',
      title: latest.memo?.trim() || names.join(' / '),
      reason: `Posted in each of ${earlier.map(monthName).join(', ')} but not yet in ${monthName(month)}. ${same ? 'The amount was the same each month.' : 'The amounts varied; this copies the latest one.'}`,
      date,
      memo: latest.memo?.trim() || `${names.join(' / ')} for ${monthName(month)}`,
      type: 'STANDARD',
      total: totalOf(latest).toFixed(scale),
      history,
      basedOn: sorted.map((j) => ({ id: j.id, entryNumber: j.entryNumber, date: j.date })),
      lines: latest.lines.map((l) => ({ accountId: l.accountId, debit: dec(l.debit).isZero() ? '' : dec(l.debit).toFixed(scale), credit: dec(l.credit).isZero() ? '' : dec(l.credit).toFixed(scale), description: l.description, departmentId: l.departmentId ?? null, projectId: l.projectId ?? null })),
    });
  }

  // ---------------------------------------------------------------- accruals
  const monthEnd = lastDayOf(month);
  if (monthEnd > today) {
    notes.push(`Accruals are suggested once ${monthName(month)} has ended.`);
  } else {
    const accrued = input.accounts.find((a) => a.type === 'LIABILITY' && a.subtype === 'ACCRUED_LIABILITY' && a.isActive && a.isPostable);
    const expenses = input.accounts.filter((a) => a.type === 'EXPENSE' && a.isActive && a.isPostable && !repeatedAccounts.has(a.id));
    const net = (accountId: string, m: string, any = false): Dec =>
      input.journals
        .filter((j) => monthOf(j) === m && j.type !== 'CLOSING' && (any || (j.status === 'POSTED' && ACCRUAL_SOURCES.has(j.source))))
        .flatMap((j) => j.lines.filter((l) => l.accountId === accountId))
        .reduce((s, l) => s.plus(dec(l.debit)).minus(dec(l.credit)), new D(0));
    const due: { a: SuggestionAccount; history: { month: string; amount: string }[]; average: Dec }[] = [];
    for (const a of expenses) {
      const amounts = earlier.map((m) => net(a.id, m));
      if (!amounts.every((x) => x.gt(0))) continue;
      // Anything on the account this month (posted or draft, any source) means it is being dealt with.
      if (thisMonth.some((j) => j.lines.some((l) => l.accountId === a.id))) continue;
      const average = amounts.reduce((s, x) => s.plus(x), new D(0)).div(amounts.length).toDecimalPlaces(scale, D.ROUND_HALF_UP);
      if (average.isZero()) continue;
      due.push({ a, history: amounts.map((x, i) => ({ month: earlier[i]!, amount: x.toFixed(scale) })), average });
    }
    if (due.length && !accrued) notes.push('Some costs look due for an accrual, but there is no active accrued liabilities account to accrue them to. Add one to the chart of accounts.');
    if (accrued) {
      const next = monthName(addMonths(month, 1));
      for (const { a, history, average } of due) {
        suggestions.push({
          key: `ACCRUAL:${a.id}`,
          kind: 'ACCRUAL',
          title: `Accrue ${a.name}`,
          reason: `${a.code} ${a.name} had costs in each of ${earlier.map(monthName).join(', ')} but none in ${monthName(month)}. This accrues the average of those months; reverse it on 1 ${next} when the bill arrives.`,
          date: monthEnd,
          memo: `Accrual: ${a.name} for ${monthName(month)} (reverse on 1 ${next})`,
          type: 'ADJUSTING',
          total: average.toFixed(scale),
          history,
          basedOn: [],
          lines: [
            { accountId: a.id, debit: average.toFixed(scale), credit: '', description: `Accrued ${a.name}, ${monthName(month)}` },
            { accountId: accrued.id, debit: '', credit: average.toFixed(scale), description: `Accrued ${a.name}, ${monthName(month)}` },
          ],
        });
      }
    }
  }
  suggestions.sort((x, y) => (x.kind === y.kind ? (x.date === y.date ? x.title.localeCompare(y.title) : x.date < y.date ? -1 : 1) : x.kind === 'REPEAT' ? -1 : 1));
  return { month, suggestions, notes };
}
