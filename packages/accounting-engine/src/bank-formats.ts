import { assertCurrencyPrecision } from './money';
import { D, type Dec } from './money';
import { parseStatementAmount, parseStatementDate, StatementImportError, type DateFormat, type ParsedStatementLine } from './bank';

/**
 * Bank statement files other than CSV (BANK-003): OFX/QFX (SGML 1.x or XML 2.x), QIF and
 * SWIFT MT940. Each gives the same lines as a CSV import, so duplicates, reconciliation locks
 * and matching work the same. The bank's own totals, where the format carries them, are
 * returned so a file that does not add up can be flagged.
 */

export const STATEMENT_FORMATS = ['CSV', 'OFX', 'QIF', 'MT940'] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

export interface StatementFile {
  format: Exclude<StatementFormat, 'CSV'>;
  lines: ParsedStatementLine[];
  /** Opening and closing balance the file states (MT940 :60F:/:62F:; OFX LEDGERBAL as closing). */
  opening: Dec | null;
  closing: Dec | null;
  /** The currency the file states, when it does. */
  currency: string | null;
}

/** Recognises a statement file from its content, or null for anything else (CSV is chosen by the person). */
export function detectStatementFormat(text: string): Exclude<StatementFormat, 'CSV'> | null {
  const head = text.slice(0, 4000);
  if (/OFXHEADER|<OFX>/i.test(head)) return 'OFX';
  if (/^\s*!Type:/im.test(head)) return 'QIF';
  if (/^:20:/m.test(head) && /^:61:/m.test(text)) return 'MT940';
  return null;
}

const finish = (lines: ParsedStatementLine[], issues: string[]) => {
  if (issues.length) throw new StatementImportError(issues.slice(0, 50));
  if (lines.length === 0) throw new StatementImportError(['The file has no statement lines']);
  if (lines.length > 5000) throw new StatementImportError(['A file can hold at most 5,000 lines; split it']);
  return lines;
};

const clean = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ OFX

function ofxField(block: string, tag: string): string | null {
  // SGML leaves elements unclosed (<TAG>value), XML closes them; both end at the next tag or line end.
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1].trim() || null : null;
}

function ofxDate(raw: string, row: number): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (!m) throw new Error(`Transaction ${row}: "${raw}" is not an OFX date`);
  return parseStatementDate(`${m[1]}-${m[2]}-${m[3]}`, 'YYYY-MM-DD');
}

function ofxAmount(raw: string): Dec | null {
  // A few banks write a decimal comma; OFX itself uses a point.
  const v = /^-?\d+,\d{1,2}$/.test(raw.trim()) ? raw.trim().replace(',', '.') : raw;
  return parseStatementAmount(v);
}

export function parseOfx(text: string, currency: string): StatementFile {
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]);
  const issues: string[] = [];
  const lines: ParsedStatementLine[] = [];
  blocks.forEach((b, i) => {
    const row = i + 1;
    try {
      const posted = ofxField(b, 'DTPOSTED');
      if (!posted) throw new Error('no posting date');
      const date = ofxDate(posted, row);
      const amount = ofxAmount(ofxField(b, 'TRNAMT') ?? '');
      if (!amount || amount.isZero()) throw new Error('amount is missing or zero');
      assertCurrencyPrecision(amount, currency);
      const name = ofxField(b, 'NAME');
      const memo = ofxField(b, 'MEMO');
      const description = clean([name, memo && memo !== name ? memo : null].filter(Boolean).join(' - ')) || clean(ofxField(b, 'TRNTYPE') ?? '');
      if (!description) throw new Error('description is empty');
      const reference = ofxField(b, 'CHECKNUM') ?? ofxField(b, 'REFNUM') ?? ofxField(b, 'FITID');
      lines.push({ row, date, description: description.slice(0, 500), reference: reference ? clean(reference).slice(0, 100) : null, amount, balance: null });
    } catch (e) {
      issues.push(`Transaction ${row}: ${(e as Error).message.replace(/^Transaction \d+: /, '')}`);
    }
  });
  const ledger = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|$)/i.exec(text);
  const closingRaw = ledger ? ofxField(ledger[1], 'BALAMT') : null;
  return { format: 'OFX', lines: finish(lines, issues), opening: null, closing: closingRaw ? ofxAmount(closingRaw) : null, currency: ofxField(text, 'CURDEF') };
}

// ------------------------------------------------------------------ QIF

/** QIF dates come as 25/12/2026, 12/25/2026, 25/12'26 or 25-12-26: the person says day or month first. */
function qifDate(raw: string, dayFirst: boolean): string {
  const m = /^\s*(\d{1,2})[/.-](\d{1,2})(?:[/.-]|'\s*)(\d{2}|\d{4})\s*$/.exec(raw);
  if (!m) throw new Error(`"${raw}" is not a QIF date`);
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  const [d, mo] = dayFirst ? [m[1], m[2]] : [m[2], m[1]];
  return parseStatementDate(`${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, 'YYYY-MM-DD');
}

export function parseQif(text: string, currency: string, dateFormat: DateFormat): StatementFile {
  const dayFirst = !dateFormat.startsWith('MM');
  const issues: string[] = [];
  const lines: ParsedStatementLine[] = [];
  let cur: Record<string, string> = {};
  let row = 0;
  const flush = () => {
    if (!Object.keys(cur).length) return;
    row += 1;
    try {
      if (!cur.D) throw new Error('no date');
      const date = qifDate(cur.D, dayFirst);
      const amount = parseStatementAmount(cur.T ?? cur.U ?? '');
      if (!amount || amount.isZero()) throw new Error('amount is missing or zero');
      assertCurrencyPrecision(amount, currency);
      const description = clean([cur.P, cur.M && cur.M !== cur.P ? cur.M : null].filter(Boolean).join(' - '));
      if (!description) throw new Error('description is empty');
      lines.push({ row, date, description: description.slice(0, 500), reference: cur.N ? clean(cur.N).slice(0, 100) : null, amount, balance: null });
    } catch (e) {
      issues.push(`Transaction ${row}: ${(e as Error).message}`);
    }
    cur = {};
  };
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trimEnd();
    if (!l || l.startsWith('!')) continue;
    if (l.startsWith('^')) {
      flush();
      continue;
    }
    const code = l[0];
    // Split lines (S, E, $) belong to categories, not to the bank movement.
    if ('DTUPMN'.includes(code) && cur[code] === undefined) cur[code] = l.slice(1).trim();
  }
  flush();
  return { format: 'QIF', lines: finish(lines, issues), opening: null, closing: null, currency: null };
}

// ------------------------------------------------------------------ MT940

const mtAmount = (raw: string) => new D(raw.replace(',', '.').replace(/\.$/, ''));
const mtDate = (yymmdd: string) => parseStatementDate(`20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`, 'YYYY-MM-DD');

function mtBalance(field: string | undefined): { amount: Dec; currency: string } | null {
  if (!field) return null;
  const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(field.trim());
  if (!m) return null;
  const a = mtAmount(m[4]);
  return { amount: m[1] === 'D' ? a.negated() : a, currency: m[3] };
}

export function parseMt940(text: string, currency: string): StatementFile {
  // Fields start with :tag: at the start of a line; continuation lines belong to the field before.
  const fields: { tag: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(raw);
    if (m) fields.push({ tag: m[1], value: m[2] });
    else if (fields.length && raw.trim() && !/^-\}?$/.test(raw.trim()) && !raw.startsWith('{')) fields[fields.length - 1].value += `\n${raw}`;
  }
  const issues: string[] = [];
  const lines: ParsedStatementLine[] = [];
  let opening: { amount: Dec; currency: string } | null = null;
  let closing: { amount: Dec; currency: string } | null = null;
  let row = 0;
  fields.forEach((f, i) => {
    if ((f.tag === '60F' || f.tag === '60M') && !opening) opening = mtBalance(f.value);
    if (f.tag === '62F' || f.tag === '62M') closing = mtBalance(f.value);
    if (f.tag !== '61') return;
    row += 1;
    try {
      const first = f.value.split('\n')[0];
      const m = /^(\d{6})(\d{4})?(R?[CD])([A-Z])?(\d+,\d{0,2})([A-Z]\w{3})?([^/\n]*)(?:\/\/(.*))?$/.exec(first.trim());
      if (!m) throw new Error(`"${first.trim()}" is not an MT940 statement line`);
      const date = mtDate(m[1]);
      // RC (reversal of credit) takes money out; RD (reversal of debit) brings it back.
      const out = m[3] === 'D' || m[3] === 'RC';
      const amount = out ? mtAmount(m[5]).negated() : mtAmount(m[5]);
      if (amount.isZero()) throw new Error('amount is zero');
      assertCurrencyPrecision(amount, currency);
      const info = fields[i + 1]?.tag === '86' ? fields[i + 1].value : '';
      const extra = f.value.split('\n').slice(1).join(' ');
      const description = clean(info.replace(/\?\d{2}/g, ' ') || extra || m[7] || 'Bank transaction');
      const reference = clean(m[7] && m[7] !== 'NONREF' ? m[7] : (m[8] ?? '')) || null;
      lines.push({ row, date, description: description.slice(0, 500), reference: reference ? reference.slice(0, 100) : null, amount, balance: null });
    } catch (e) {
      issues.push(`Transaction ${row}: ${(e as Error).message}`);
    }
  });
  const o = opening as { amount: Dec; currency: string } | null;
  const c = closing as { amount: Dec; currency: string } | null;
  return { format: 'MT940', lines: finish(lines, issues), opening: o?.amount ?? null, closing: c?.amount ?? null, currency: o?.currency ?? c?.currency ?? null };
}

export function parseStatementFile(format: Exclude<StatementFormat, 'CSV'>, text: string, currency: string, dateFormat: DateFormat = 'DD/MM/YYYY'): StatementFile {
  return format === 'OFX' ? parseOfx(text, currency) : format === 'QIF' ? parseQif(text, currency, dateFormat) : parseMt940(text, currency);
}

/** For a file that states its opening and closing balance: whether its lines add up to the difference. */
export function fileTotalsCheck(f: Pick<StatementFile, 'opening' | 'closing' | 'lines'>): { opening: Dec; closing: Dec; computed: Dec; difference: Dec } | null {
  if (!f.opening || !f.closing) return null;
  const computed = f.lines.reduce((s, l) => s.plus(l.amount), f.opening);
  return { opening: f.opening, closing: f.closing, computed, difference: f.closing.minus(computed) };
}
