import { Dec, assertCurrencyPrecision, dec } from './money';
import { assertIsoDate } from './periods';

/**
 * Bank statements and reconciliation (Directive Part 8).
 *
 * A statement line is money that moved in the bank: positive = money in,
 * negative = money out. It is matched to posted journal lines on the bank's
 * ledger account whose net (debit − credit) equals the statement amount.
 * Matching is rule based (amount, date distance, shared reference words);
 * nothing here is AI and nothing here posts to the ledger.
 */

// ---------------------------------------------------------------- CSV parsing

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, delimiter , ; or tab. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new StatementImportError(['The file ends inside a quoted field']);
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface StatementMapping {
  /** Zero-based column indexes. Either `amount`, or `debit` and/or `credit` (money out / money in). */
  date: number;
  description: number;
  reference?: number | null;
  amount?: number | null;
  moneyOut?: number | null;
  moneyIn?: number | null;
  dateFormat: DateFormat;
  hasHeader: boolean;
  delimiter?: ',' | ';' | '\t';
  /** When the bank shows money out as positive in a single amount column. */
  invertAmount?: boolean;
}

export interface ParsedStatementLine {
  row: number;
  date: string;
  description: string;
  reference: string | null;
  amount: Dec;
}

export class StatementImportError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'StatementImportError';
  }
}

export function parseStatementDate(raw: string, format: DateFormat): string {
  const v = raw.trim();
  let y: string, m: string, d: string;
  if (format === 'YYYY-MM-DD') {
    const r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
    if (!r) throw new Error(`"${raw}" is not a YYYY-MM-DD date`);
    [, y, m, d] = r;
  } else {
    const sep = format[2];
    const r = new RegExp(`^(\\d{1,2})\\${sep}(\\d{1,2})\\${sep}(\\d{4})$`).exec(v);
    if (!r) throw new Error(`"${raw}" is not a ${format} date`);
    if (format.startsWith('DD')) [, d, m, y] = r;
    else [, m, d, y] = r;
  }
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  assertIsoDate(iso);
  return iso;
}

/** Parses "1,234.50", "-12.00", "(12.00)", "12.00 CR", "₹ 1,000". Never uses floating point. */
export function parseStatementAmount(raw: string): Dec | null {
  let v = raw.trim().replace(/[₹$€£\s]/g, '');
  if (v === '' || v === '-') return null;
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  if (/DR$/i.test(v)) {
    negative = !negative;
    v = v.slice(0, -2);
  } else if (/CR$/i.test(v)) v = v.slice(0, -2);
  if (v.startsWith('-')) {
    negative = !negative;
    v = v.slice(1);
  } else if (v.startsWith('+')) v = v.slice(1);
  if (!/^(\d{1,3}(,\d{2,3})*|\d+)(\.\d+)?$/.test(v)) throw new Error(`"${raw}" is not an amount`);
  const n = dec(v.replace(/,/g, ''));
  return negative ? n.negated() : n;
}

export function parseStatement(text: string, mapping: StatementMapping, currency: string): ParsedStatementLine[] {
  const rows = parseCsv(text, mapping.delimiter ?? ',');
  const body = mapping.hasHeader ? rows.slice(1) : rows;
  const offset = mapping.hasHeader ? 2 : 1;
  const single = mapping.amount !== undefined && mapping.amount !== null;
  if (!single && (mapping.moneyIn ?? null) === null && (mapping.moneyOut ?? null) === null) {
    throw new StatementImportError(['Choose an amount column, or money-in / money-out columns']);
  }
  const issues: string[] = [];
  const lines: ParsedStatementLine[] = [];
  const cell = (r: string[], i: number | null | undefined) => (i === null || i === undefined ? '' : (r[i] ?? '').trim());
  body.forEach((r, idx) => {
    const rowNo = idx + offset;
    try {
      const date = parseStatementDate(cell(r, mapping.date), mapping.dateFormat);
      let amount: Dec | null;
      if (single) {
        amount = parseStatementAmount(cell(r, mapping.amount));
        if (amount && mapping.invertAmount) amount = amount.negated();
      } else {
        const inn = parseStatementAmount(cell(r, mapping.moneyIn));
        const out = parseStatementAmount(cell(r, mapping.moneyOut));
        if (inn && !inn.isZero() && out && !out.isZero()) throw new Error('both money in and money out are filled');
        amount = inn && !inn.isZero() ? inn.abs() : out ? out.abs().negated() : null;
      }
      if (!amount || amount.isZero()) throw new Error('amount is missing or zero');
      assertCurrencyPrecision(amount, currency);
      const description = cell(r, mapping.description).replace(/\s+/g, ' ');
      if (!description) throw new Error('description is empty');
      lines.push({ row: rowNo, date, description: description.slice(0, 500), reference: cell(r, mapping.reference).slice(0, 100) || null, amount });
    } catch (e) {
      issues.push(`Row ${rowNo}: ${(e as Error).message}`);
    }
  });
  if (issues.length) throw new StatementImportError(issues.slice(0, 50));
  if (lines.length === 0) throw new StatementImportError(['The file has no statement lines']);
  if (lines.length > 5000) throw new StatementImportError(['A file can hold at most 5,000 lines; split it']);
  return lines;
}

/**
 * Stable identity of a statement line, so re-importing an overlapping file skips
 * lines already imported. Identical lines in one file are told apart by their
 * occurrence number. The API stores a SHA-256 of each key.
 */
export function statementLineKeys(accountId: string, lines: Pick<ParsedStatementLine, 'date' | 'amount' | 'description' | 'reference'>[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = [accountId, l.date, l.amount.toFixed(), l.description.toLowerCase(), (l.reference ?? '').toLowerCase()].join('\u0001');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}\u0001${n}`;
  });
}

// ------------------------------------------------------------------- matching

export interface MatchLine {
  id: string;
  date: string;
  amount: Dec;
  text: string;
}

export interface MatchSuggestion {
  statementLineId: string;
  journalLineId: string;
  score: number;
  reasons: string[];
}

export const MATCH_WINDOW_DAYS = 14;

function days(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

const STOP = new Set(['the', 'and', 'for', 'from', 'to', 'by', 'payment', 'transfer', 'neft', 'imps', 'rtgs', 'upi', 'ref', 'inr', 'pvt', 'ltd']);
function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/**
 * One-to-one suggestions: same amount, within MATCH_WINDOW_DAYS, scored by
 * closeness in date and shared words (e.g. "INV-000012" or a customer name).
 * `unique` is true when the pair is each other's only best candidate, which is
 * the only case the "match all suggested" action applies.
 */
export function suggestMatches(statement: MatchLine[], ledger: MatchLine[]): (MatchSuggestion & { unique: boolean })[] {
  const candidates: MatchSuggestion[] = [];
  for (const s of statement) {
    const sw = words(s.text);
    for (const l of ledger) {
      if (!s.amount.eq(l.amount)) continue;
      const gap = days(s.date, l.date);
      if (gap > MATCH_WINDOW_DAYS) continue;
      const shared = [...words(l.text)].filter((w) => sw.has(w));
      const reasons = ['Same amount', gap === 0 ? 'Same date' : `${gap} day${gap === 1 ? '' : 's'} apart`];
      if (shared.length) reasons.push(`Shared text: ${shared.slice(0, 3).join(', ')}`);
      const score = 50 + Math.max(0, 30 - gap * 2) + Math.min(20, shared.length * 10);
      candidates.push({ statementLineId: s.id, journalLineId: l.id, score, reasons });
    }
  }
  const best = new Map<string, MatchSuggestion>();
  const countFor = new Map<string, number>();
  for (const c of candidates) {
    countFor.set(c.statementLineId, (countFor.get(c.statementLineId) ?? 0) + 1);
    countFor.set(`j:${c.journalLineId}`, (countFor.get(`j:${c.journalLineId}`) ?? 0) + 1);
    const cur = best.get(c.statementLineId);
    if (!cur || c.score > cur.score || (c.score === cur.score && c.journalLineId < cur.journalLineId)) best.set(c.statementLineId, c);
  }
  return [...best.values()].map((b) => ({ ...b, unique: countFor.get(b.statementLineId) === 1 && countFor.get(`j:${b.journalLineId}`) === 1 }));
}

// -------------------------------------------------------------- reconciliation

export interface ReconciliationFigures {
  /** Opening statement balance + Σ statement lines in the range. */
  computedStatementBalance: Dec;
  /** What the user typed from the bank statement. */
  statementBalance: Dec;
  /** General-ledger balance of the bank account at the statement date. */
  ledgerBalance: Dec;
  /** Σ ledger movements not yet seen on the statement (deposits in transit − outstanding payments). */
  uncleared: Dec;
}

export function reconciliationIssues(f: ReconciliationFigures, unmatchedLines: number): string[] {
  const issues: string[] = [];
  if (!f.computedStatementBalance.eq(f.statementBalance)) {
    issues.push(
      `The imported lines add up to ${f.computedStatementBalance.toFixed(2)}, but the statement shows ${f.statementBalance.toFixed(2)} (difference ${f.statementBalance.minus(f.computedStatementBalance).toFixed(2)}). A line may be missing or imported twice.`,
    );
  }
  if (unmatchedLines > 0) issues.push(`${unmatchedLines} statement line${unmatchedLines === 1 ? ' is' : 's are'} not matched or excluded yet`);
  const diff = reconciliationDifference(f);
  if (!diff.isZero()) issues.push(`Ledger balance less uncleared items differs from the statement by ${diff.toFixed(2)}`);
  return issues;
}

/** Ledger balance − uncleared − statement balance. Zero when the account reconciles. */
export function reconciliationDifference(f: Pick<ReconciliationFigures, 'ledgerBalance' | 'uncleared' | 'statementBalance'>): Dec {
  return f.ledgerBalance.minus(f.uncleared).minus(f.statementBalance);
}
