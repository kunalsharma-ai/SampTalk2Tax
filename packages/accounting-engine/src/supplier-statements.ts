import { D, dec } from './money';

/**
 * Supplier statement reconciliation (AP-011). A supplier sends a statement of account for a
 * period: an opening balance, the invoices, debit notes, credit notes and payments they recorded,
 * and a closing balance. This matches each line to a bill, vendor credit or payment in the books
 * and explains the difference between their closing balance and ours:
 * - lines only on their statement (a bill not entered yet, a payment we have not recorded);
 * - items only in our books (a payment they have not received yet, a bill they do not know);
 * - matched items whose amounts differ;
 * - a different opening balance;
 * - the statement's own arithmetic, when its lines do not add up from its opening to its closing.
 * Together these always account for the whole difference. Amounts are what we owe the supplier: invoices and debit
 * notes raise it, credit notes and payments lower it.
 */
export const SUPPLIER_STATEMENT_LINE_KINDS = ['INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'PAYMENT'] as const;
export type SupplierStatementLineKind = (typeof SUPPLIER_STATEMENT_LINE_KINDS)[number];

export interface SupplierStatementLine {
  date: string;
  /** The supplier's invoice, note or payment reference. */
  reference: string;
  kind: SupplierStatementLineKind;
  /** Positive. */
  amount: string;
  description?: string | null;
}

/** A bill, vendor credit or payment as it stands in the books in the period. */
export interface BookItem {
  id: string;
  kind: 'BILL' | 'VENDOR_CREDIT' | 'PAYMENT' | 'BILL_VOID' | 'VENDOR_CREDIT_VOID' | 'PAYMENT_VOID';
  number: string;
  date: string;
  /** The supplier's invoice number on a bill, or the payment reference (UTR, cheque number). */
  reference: string | null;
  /** Signed: what it does to the amount we owe. */
  amount: string;
}

export interface StatementInput {
  theirOpening: string;
  theirClosing: string;
  ourOpening: string;
  ourClosing: string;
  lines: readonly SupplierStatementLine[];
  items: readonly BookItem[];
}

export const statementLineSign = (k: SupplierStatementLineKind) => (k === 'INVOICE' || k === 'DEBIT_NOTE' ? 1 : -1); // not money
const ITEM_FOR: Record<SupplierStatementLineKind, BookItem['kind']> = { INVOICE: 'BILL', DEBIT_NOTE: 'BILL', CREDIT_NOTE: 'VENDOR_CREDIT', PAYMENT: 'PAYMENT' };
/** Days apart that a payment can still be the same payment (bank transfers land later in their books). */
export const PAYMENT_DAYS = 10; // not money
/** Days apart for a bill or note matched by amount when the references differ. */
export const DOCUMENT_DAYS = 7; // not money

/** References compared without case, separators or leading zeros in each number: PM/26-27/0101 is PM-26-27-101. */
export const normaliseReference = (r: string | null | undefined) => ((r ?? '').toUpperCase().match(/[A-Z]+|\d+/g) ?? []).map((t) => (/^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t)).join('');
const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000; // not money

export interface StatementMatch {
  line: number;
  itemId: string;
  itemNumber: string;
  itemKind: BookItem['kind'];
  by: 'REFERENCE' | 'AMOUNT_AND_DATE';
  theirs: string;
  ours: string;
  /** Theirs less ours (signed): non-zero when the amounts differ. */
  difference: string;
}

export interface StatementReconciliation {
  matches: StatementMatch[];
  onlyOnStatement: { line: number; date: string; reference: string; kind: SupplierStatementLineKind; amount: string; effect: string; action: string }[];
  onlyInBooks: { id: string; kind: BookItem['kind']; number: string; date: string; reference: string | null; effect: string; action: string }[];
  balances: { theirOpening: string; ourOpening: string; theirClosing: string; ourClosing: string; difference: string };
  /** What explains their closing less ours. */
  explained: { opening: string; onlyOnStatement: string; onlyInBooks: string; amountDifferences: string; statementArithmetic: string };
  /** The statement's own lines do not add up from its opening to its closing balance. */
  statementAddsUp: boolean;
  agrees: boolean;
}

/** Match a supplier's statement to the books and explain the difference in closing balances. */
export function reconcileSupplierStatement(s: StatementInput): StatementReconciliation {
  const used = new Set<string>();
  const items = s.items.filter((i) => !i.kind.endsWith('_VOID'));
  const voids = s.items.filter((i) => i.kind.endsWith('_VOID'));
  // A document or payment voided in the same period nets to nothing: neither side is shown.
  const voidedIds = new Set(voids.filter((v) => items.some((i) => i.id === v.id)).map((v) => v.id));
  const live = items.filter((i) => !voidedIds.has(i.id));
  const matches: StatementMatch[] = [];
  const unmatched: number[] = [];
  const signed = (l: SupplierStatementLine) => dec(l.amount).times(statementLineSign(l.kind));
  const record = (idx: number, item: BookItem, by: StatementMatch['by']) => {
    used.add(item.id);
    const theirs = signed(s.lines[idx]!);
    matches.push({ line: idx, itemId: item.id, itemNumber: item.number, itemKind: item.kind, by, theirs: theirs.toFixed(2), ours: dec(item.amount).toFixed(2), difference: theirs.minus(dec(item.amount)).toFixed(2) });
  };
  // 1. By reference: the supplier's invoice number on the bill, or the payment reference.
  s.lines.forEach((l, idx) => {
    const ref = normaliseReference(l.reference);
    const item = ref ? live.find((i) => !used.has(i.id) && i.kind === ITEM_FOR[l.kind] && (normaliseReference(i.reference) === ref || normaliseReference(i.number) === ref)) : undefined;
    if (item) record(idx, item, 'REFERENCE');
    else unmatched.push(idx);
  });
  // 2. By amount and date, closest date first.
  const left: number[] = [];
  for (const idx of unmatched) {
    const l = s.lines[idx]!;
    const window = l.kind === 'PAYMENT' ? PAYMENT_DAYS : DOCUMENT_DAYS;
    const candidates = live.filter((i) => !used.has(i.id) && i.kind === ITEM_FOR[l.kind] && dec(i.amount).eq(signed(l)) && daysApart(i.date, l.date) <= window).sort((a, b) => daysApart(a.date, l.date) - daysApart(b.date, l.date));
    if (candidates[0]) record(idx, candidates[0], 'AMOUNT_AND_DATE');
    else left.push(idx);
  }
  const onlyOnStatement = left.map((idx) => {
    const l = s.lines[idx]!;
    const action =
      l.kind === 'PAYMENT'
        ? 'They show a payment from you that is not in your books. Find it in the bank and record it, or ask them which payment it is.'
        : l.kind === 'CREDIT_NOTE'
          ? 'They gave you a credit that is not in your books. Ask for the credit note and record it as a vendor credit.'
          : 'Not in your books. Ask for a copy and enter the bill, or tell them it was not received.';
    return { line: idx, date: l.date, reference: l.reference, kind: l.kind, amount: dec(l.amount).toFixed(2), effect: signed(l).toFixed(2), action };
  });
  const onlyInBooks = [...live.filter((i) => !used.has(i.id)), ...voids.filter((v) => !voidedIds.has(v.id))].map((i) => ({
    id: i.id,
    kind: i.kind,
    number: i.number,
    date: i.date,
    reference: i.reference,
    effect: dec(i.amount).toFixed(2),
    action: i.kind === 'PAYMENT'
      ? 'Not on their statement yet: usually a payment still on its way. Send them the payment details if it is old.'
      : i.kind === 'BILL'
        ? 'Not on their statement. Check the bill is theirs and for this period; send them a copy.'
        : i.kind === 'VENDOR_CREDIT'
          ? 'They have not recorded this credit. Send them the credit note or agreement behind it.'
          : 'Voided in your books in this period, but recorded before it. Check they reversed it too.',
  }));
  const sum = (xs: readonly { effect: string }[]) => xs.reduce((a, x) => a.plus(dec(x.effect)), new D(0));
  const linesTotal = s.lines.reduce((a, l) => a.plus(signed(l)), new D(0));
  const arithmetic = dec(s.theirClosing).minus(dec(s.theirOpening)).minus(linesTotal);
  const difference = dec(s.theirClosing).minus(dec(s.ourClosing));
  const opening = dec(s.theirOpening).minus(dec(s.ourOpening));
  const onStatement = sum(onlyOnStatement);
  const inBooks = sum(onlyInBooks).negated();
  const amountDifferences = matches.reduce((a, m) => a.plus(dec(m.difference)), new D(0));
  return {
    matches,
    onlyOnStatement,
    onlyInBooks,
    balances: { theirOpening: dec(s.theirOpening).toFixed(2), ourOpening: dec(s.ourOpening).toFixed(2), theirClosing: dec(s.theirClosing).toFixed(2), ourClosing: dec(s.ourClosing).toFixed(2), difference: difference.toFixed(2) },
    explained: { opening: opening.toFixed(2), onlyOnStatement: onStatement.toFixed(2), onlyInBooks: inBooks.toFixed(2), amountDifferences: amountDifferences.toFixed(2), statementArithmetic: arithmetic.toFixed(2) },
    statementAddsUp: arithmetic.isZero(),
    agrees: difference.isZero() && !onlyOnStatement.length && !onlyInBooks.length && matches.every((m) => dec(m.difference).isZero()),
  };
}

const KIND_WORDS: Record<string, SupplierStatementLineKind> = { INVOICE: 'INVOICE', BILL: 'INVOICE', INV: 'INVOICE', 'DEBIT NOTE': 'DEBIT_NOTE', DEBIT_NOTE: 'DEBIT_NOTE', DN: 'DEBIT_NOTE', 'CREDIT NOTE': 'CREDIT_NOTE', CREDIT_NOTE: 'CREDIT_NOTE', CN: 'CREDIT_NOTE', PAYMENT: 'PAYMENT', RECEIPT: 'PAYMENT', PMT: 'PAYMENT' };

/** Splits one CSV row into trimmed cells, honouring "quoted, cells" and "" escapes, in one pass. */
function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) { // not money
    const ch = row[i];
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') { cell += '"'; i += 1; } // not money
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell.trim()); cell = ''; }
    else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Lines pasted from a statement as CSV: date, reference, type, amount (a header row is skipped).
 * Dates as YYYY-MM-DD or DD/MM/YYYY; type as invoice, debit note, credit note or payment
 * (receipt); amounts may carry commas. Returns the lines and the problems, by row number.
 */
export function parseStatementCsv(text: string): { lines: SupplierStatementLine[]; errors: string[] } {
  const lines: SupplierStatementLine[] = [];
  const errors: string[] = [];
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  rows.forEach((row, i) => {
    const cells = splitCsvRow(row).slice(0, 5);
    if (i === 0 && /date/i.test(cells[0] ?? '')) return;
    const n = i + 1; // not money
    const [dateRaw = '', reference = '', typeRaw = '', amountRaw = ''] = cells;
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(dateRaw);
    const date = m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : dateRaw;
    const kind = KIND_WORDS[typeRaw.toUpperCase().replace(/\s+/g, ' ')];
    const amount = amountRaw.replace(/[,\s₹]/g, '');
    const problems: string[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) problems.push(`date "${dateRaw}"`);
    if (!reference) problems.push('no reference');
    if (!kind) problems.push(`type "${typeRaw}" (use invoice, debit note, credit note or payment)`);
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || dec(amount || '0').isZero()) problems.push(`amount "${amountRaw}"`);
    if (problems.length) errors.push(`Row ${n}: ${problems.join(', ')}`);
    else lines.push({ date, reference, kind: kind!, amount: dec(amount).toFixed(2) });
  });
  return { lines, errors };
}
