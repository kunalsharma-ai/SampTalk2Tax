/**
 * Reads a supplier's bill from its text (AP-025): the supplier and their tax number, the bill
 * number, the bill and due dates, the currency, the line items, the subtotal, the taxes and the
 * total. It is a deterministic reader of the layouts accounting software prints (labels such as
 * "Invoice No", "Due Date", "Sub Total", "CGST @ 9%", "Grand Total", and a table of items with
 * quantity, rate and amount); it never guesses a number that is not on the bill. Every field
 * says whether it was found on the bill, guessed from it, or is missing, and the checks say in
 * words where the bill does not add up, so a person reviews it before it is saved as a draft.
 *
 * No framework or database code. No regular expressions with nested or overlapping repeats run
 * on the text (it comes from an uploaded file).
 */
import { addDays } from './documents';
import { D, type Dec } from './money';

export type FieldSource = 'FOUND' | 'GUESSED' | 'MISSING';
export interface Field<T> {
  value: T | null;
  source: FieldSource;
}
export interface BillVendor {
  id: string;
  name: string;
  taxId: string | null;
}
export interface ExtractedBillLine {
  description: string;
  hsnCode: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  /** The line of the text it was read from, counted from 1. */
  sourceLine: number;
}
export interface ExtractedTax {
  label: string;
  rate: string | null;
  amount: string;
}
export interface ExtractedBill {
  supplier: { name: string | null; taxId: string | null; contactId: string | null; matchedBy: 'TAX_ID' | 'NAME' | null; source: FieldSource };
  buyerTaxId: string | null;
  invoiceNumber: Field<string>;
  issueDate: Field<string>;
  dueDate: Field<string>;
  currency: Field<string>;
  lines: ExtractedBillLine[];
  linesFrom: 'TABLE' | 'TOTAL_ONLY' | 'NONE';
  subtotal: string | null;
  taxes: ExtractedTax[];
  taxTotal: string | null;
  rounding: string | null;
  total: string | null;
  /** The tax rate across the bill when it is the same for every line, e.g. "18". */
  taxPercent: Field<string>;
  checks: string[];
}
export interface BillReadingContext {
  vendors: readonly BillVendor[];
  /** The organisation's own tax numbers, so the buyer's number is not taken for the supplier's. */
  ownTaxIds: readonly string[];
  currency: string;
  today: string;
}

const MAX_TEXT = 200_000; // not money
const MAX_LINES = 400; // not money

// ------------------------------------------------------------------ small readers

const isDigitCh = (c: string) => c >= '0' && c <= '9';
const isLetter = (c: string) => c.toLowerCase() !== c.toUpperCase();
const hasLetter = (s: string) => [...s].some(isLetter);
const hasDigit = (s: string) => [...s].some(isDigitCh);

const CURRENCY_MARKS: [string, string][] = [
  ['₹', 'INR'],
  ['rs.', 'INR'],
  ['inr', 'INR'],
  ['us$', 'USD'],
  ['usd', 'USD'],
  ['$', 'USD'],
  ['€', 'EUR'],
  ['eur', 'EUR'],
  ['£', 'GBP'],
  ['gbp', 'GBP'],
  ['aed', 'AED'],
  ['sgd', 'SGD'],
  ['aud', 'AUD'],
  ['cad', 'CAD'],
];

/**
 * An amount written on a bill: "1,23,456.78", "Rs. 450", "₹8,260.00", "1234.5", "-0.40",
 * "(12.00)" or "500/-". Returns null when the token is not an amount.
 */
export function readAmount(token: string): Dec | null {
  let t = token.trim();
  if (!t) return null;
  let negative = false;
  if (t.startsWith('(') && t.endsWith(')')) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith('/-')) t = t.slice(0, -2);
  const lower = t.toLowerCase();
  for (const [mark] of CURRENCY_MARKS) {
    if (lower.startsWith(mark)) {
      t = t.slice(mark.length).trim();
      break;
    }
  }
  if (lower.startsWith('rs') && !lower.startsWith('rs.')) t = t.slice(2).trim();
  if (t.startsWith('-')) {
    negative = !negative;
    t = t.slice(1);
  } else if (t.startsWith('+')) t = t.slice(1);
  if (!t || !isDigitCh(t[0]!)) return null;
  let dot = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === '.') {
      if (dot >= 0) return null;
      dot = i;
    } else if (c === ',') {
      if (dot >= 0 || !isDigitCh(t[i - 1] ?? '') || !isDigitCh(t[i + 1] ?? '')) return null;
    } else if (!isDigitCh(c)) return null;
  }
  if (dot === t.length - 1) t = t.slice(0, -1);
  if (dot >= 0 && t.length - dot - 1 > 4) return null;
  const v = new D(t.split(',').join(''));
  return negative ? v.negated() : v;
}

/** A percentage such as "18%", "9 %" or "@9%"; null otherwise. */
function readPercent(token: string, next?: string): Dec | null {
  let t = token.trim();
  if (t.startsWith('@')) t = t.slice(1);
  if (t.endsWith('%')) t = t.slice(0, -1);
  else if (next?.trim() !== '%') return null;
  if (!t || [...t].some((c) => !isDigitCh(c) && c !== '.')) return null;
  return new D(t);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (w: string) => {
  const l = w.toLowerCase().replace(/[.,]/g, '');
  if (l.length < 3) return 0;
  const i = MONTHS.findIndex((m) => l.startsWith(m) && (l.length === 3 || 'january february march april may june july august september october november december sept'.split(' ').some((f) => f.startsWith(l))));
  return i + 1;
};
const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const whole = (s: string) => (s.length > 0 && s.length <= 4 && [...s].every(isDigitCh) ? Number(s) : NaN);

/**
 * The first date in a piece of text: 05/10/2026, 5-10-26, 05.10.2026 and 2026-10-05 (day before
 * month, as bills in India and most countries write it), 5 Oct 2026, 05-Oct-2026 and Oct 5, 2026.
 */
export function readDate(text: string): string | null {
  const words = text.split(/[\s,]+/).filter(Boolean); // single character class: linear
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.replace(/[:;()]/g, '');
    const parts = w.split(/[/.-]/);
    if (parts.length === 3) {
      const [a, b, c] = parts as [string, string, string];
      if (a.length === 4 && !Number.isNaN(whole(a))) {
        const r = iso(whole(a), whole(b), whole(c));
        if (r) return r;
      } else if (!Number.isNaN(whole(a)) && !Number.isNaN(whole(c))) {
        const m = Number.isNaN(whole(b)) ? monthOf(b) : whole(b);
        const r = iso(whole(c), m, whole(a));
        if (r && (c.length === 2 || c.length === 4)) return r;
      }
    }
    // 5 Oct 2026 / 5th October 2026
    const day = whole(w.replace(/(st|nd|rd|th)$/i, ''));
    if (!Number.isNaN(day) && i + 2 < words.length && monthOf(words[i + 1]!) && !Number.isNaN(whole(words[i + 2]!))) {
      const r = iso(whole(words[i + 2]!), monthOf(words[i + 1]!), day);
      if (r) return r;
    }
    // Oct 5 2026
    if (monthOf(w) && i + 2 < words.length) {
      const d2 = whole(words[i + 1]!.replace(/(st|nd|rd|th)$/i, ''));
      const y2 = whole(words[i + 2]!);
      if (!Number.isNaN(d2) && !Number.isNaN(y2)) {
        const r = iso(y2, monthOf(w), d2);
        if (r) return r;
      }
    }
  }
  return null;
}

/** Text after a label at the start of a word, e.g. "Invoice No: GP/1" after "invoice no". */
function afterLabel(line: string, labels: readonly string[]): string | null {
  const lower = line.toLowerCase();
  for (const label of labels) {
    let at = lower.indexOf(label);
    while (at >= 0) {
      const before = at === 0 ? ' ' : lower[at - 1]!;
      const after = lower[at + label.length] ?? ' ';
      if (!isLetter(before) && !(isLetter(after) && isLetter(label[label.length - 1]!))) return line.slice(at + label.length);
      at = lower.indexOf(label, at + 1);
    }
  }
  return null;
}
const stripLead = (s: string) => {
  let i = 0;
  while (i < s.length && ' \t:.#-–=|'.includes(s[i]!)) i++;
  return s.slice(i);
};
const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** The last amount on a line (the figure column), skipping percentages. */
function lastAmount(line: string): Dec | null {
  const ws = words(line);
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i]!;
    if (w.endsWith('%') || ws[i + 1] === '%') continue;
    const a = readAmount(w);
    if (a) {
      // "Rs. 8,260.00" / "INR 8,260" are one amount written as two words
      return a;
    }
  }
  return null;
}

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
/** Tax numbers in the text: GSTINs, written alone or after a label. */
function taxIds(text: string): string[] {
  const out: string[] = [];
  for (const w of text.split(/[\s:,;|()]+/)) {
    const t = w.toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (t.length === 15 && GSTIN_SHAPE.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

const NAME_NOISE = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company', 'corp', 'the', 'and', '&']);
const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9& ]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(' ');

const HEADINGS = ['tax invoice', 'invoice', 'bill', 'bill of supply', 'original for recipient', 'duplicate for transporter', 'triplicate for supplier', 'original', 'duplicate', 'page', 'receipt', 'proforma invoice', 'commercial invoice', 'statement'];

// ------------------------------------------------------------------ the reader

const NUMBER_LABELS = ['invoice no', 'invoice number', 'invoice num', 'invoice #', 'inv no', 'inv. no', 'inv #', 'bill no', 'bill number', 'bill #', 'invoice ref', 'tax invoice no', 'document no', 'invoice id'];
const ISSUE_LABELS = ['invoice date', 'inv date', 'inv. date', 'bill date', 'date of invoice', 'date of issue', 'issue date', 'invoice dt', 'dated'];
const DUE_LABELS = ['due date', 'payment due', 'due on', 'due by', 'pay by', 'date due'];
const SUBTOTAL_LABELS = ['sub total', 'subtotal', 'sub-total', 'taxable value', 'taxable amount', 'total taxable', 'total before tax', 'total excluding tax', 'total excl', 'net amount'];
const TOTAL_LABELS = ['grand total', 'total amount payable', 'amount payable', 'total payable', 'invoice total', 'total invoice value', 'invoice value', 'total amount due', 'total due', 'balance due', 'amount due', 'total amount', 'total'];
const TAX_WORDS = ['cgst', 'sgst', 'utgst', 'igst', 'cess', 'vat', 'gst'];
const ROUND_LABELS = ['round off', 'rounding', 'rounded off', 'round-off'];
const HEADER_ITEM = ['description', 'item', 'particulars', 'product', 'service', 'details', 'goods'];
const HEADER_FIGURE = ['amount', 'total', 'value'];
const HEADER_QTY = ['qty', 'quantity', 'rate', 'price', 'hrs', 'hours', 'units', 'unit'];

function isTaxLine(lower: string) {
  if (lower.includes('gstin') || lower.includes('gst no') || lower.includes('gst number') || lower.includes('vat no') || lower.includes('vat number')) return false;
  return TAX_WORDS.some((t) => {
    const at = lower.indexOf(t);
    return at >= 0 && !isLetter(lower[at - 1] ?? ' ') && !isLetter(lower[at + t.length] ?? ' ');
  });
}
const isStopLine = (lower: string) =>
  SUBTOTAL_LABELS.some((l) => lower.includes(l)) || ROUND_LABELS.some((l) => lower.includes(l)) || lower.startsWith('total') || lower.includes('grand total') || lower.includes('amount in words') || lower.includes('rupees') || isTaxLine(lower);

/** Reads a bill from its text. */
export function extractBill(input: string, ctx: BillReadingContext): ExtractedBill {
  const text = input.slice(0, MAX_TEXT).split('\r').join('');
  const lines = text.split('\n').map((l) => l.split('\t').join('   ').trimEnd()).slice(0, MAX_LINES * 10);
  const lower = lines.map((l) => l.toLowerCase());
  const checks: string[] = [];
  const own = new Set(ctx.ownTaxIds.map((t) => t.toUpperCase()));

  // ---- supplier
  const ids = taxIds(text);
  const supplierTaxId = ids.find((t) => !own.has(t)) ?? null;
  const buyerTaxId = ids.find((t) => own.has(t)) ?? null;
  let contact: BillVendor | null = supplierTaxId ? (ctx.vendors.find((v) => v.taxId?.toUpperCase() === supplierTaxId) ?? null) : null;
  let matchedBy: 'TAX_ID' | 'NAME' | null = contact ? 'TAX_ID' : null;
  if (!contact) {
    const head = nameKey(lines.slice(0, 25).join(' '));
    const padded = ` ${head} `;
    let best: BillVendor | null = null;
    for (const v of ctx.vendors) {
      const k = nameKey(v.name);
      if (k.length >= 3 && padded.includes(` ${k} `) && (!best || k.length > nameKey(best.name).length)) best = v;
    }
    if (best) {
      contact = best;
      matchedBy = 'NAME';
    }
  }
  let supplierName: string | null = contact?.name ?? null;
  let supplierSource: FieldSource = contact ? 'FOUND' : 'MISSING';
  if (!contact) {
    for (const l of lines.slice(0, 25)) {
      const v = afterLabel(l, ['supplier:', 'seller:', 'vendor:', 'from:', 'billed by:', 'sold by:']);
      if (v && hasLetter(v)) {
        supplierName = stripLead(v).split('   ')[0]!.trim() || null;
        supplierSource = supplierName ? 'FOUND' : 'MISSING';
        break;
      }
    }
  }
  if (!supplierName) {
    for (const l of lines.slice(0, 15)) {
      const first = l.trim().split('   ')[0]!.trim();
      const fl = first.toLowerCase();
      if (!first || !hasLetter(first) || first.length < 3 || HEADINGS.includes(fl) || fl.includes(':') || taxIds(first).length) continue;
      supplierName = first.slice(0, 120);
      supplierSource = 'GUESSED';
      break;
    }
  }
  if (contact && supplierTaxId && contact.taxId && contact.taxId.toUpperCase() !== supplierTaxId) checks.push(`The bill shows GSTIN ${supplierTaxId}, but ${contact.name} is recorded with ${contact.taxId}`);
  if (contact && matchedBy === 'NAME' && supplierTaxId && !contact.taxId) checks.push(`${contact.name} has no GSTIN recorded; the bill shows ${supplierTaxId}`);

  // ---- number and dates
  const invoiceNumber: Field<string> = { value: null, source: 'MISSING' };
  const issueDate: Field<string> = { value: null, source: 'MISSING' };
  const dueDate: Field<string> = { value: null, source: 'MISSING' };
  let terms: number | null = null;
  for (const l of lines) {
    if (!invoiceNumber.value) {
      const v = afterLabel(l, NUMBER_LABELS);
      if (v !== null) {
        let rest = stripLead(v);
        if (rest.toLowerCase().startsWith('no') && !isLetter(rest[2] ?? ' ')) rest = stripLead(rest.slice(2));
        let tok = rest.split(/\s/)[0] ?? '';
        while (tok.endsWith(',') || tok.endsWith(';')) tok = tok.slice(0, -1);
        if (tok && hasDigit(tok) && tok.length <= 40 && !readDate(tok)) invoiceNumber.value = tok;
      }
    }
    if (!dueDate.value) {
      const v = afterLabel(l, DUE_LABELS);
      const d = v !== null ? readDate(v) : null;
      if (d) dueDate.value = d;
    }
    if (!issueDate.value) {
      const v = afterLabel(l, ISSUE_LABELS);
      const d = v !== null ? readDate(v) : null;
      if (d) issueDate.value = d;
    }
    if (terms === null) {
      const v = afterLabel(l, ['net', 'within', 'payment terms:', 'terms:']);
      if (v !== null) {
        const n = whole(stripLead(v).split(/\s/)[0] ?? '');
        if (!Number.isNaN(n) && n > 0 && n <= 365) terms = n;
      }
    }
  }
  if (invoiceNumber.value) invoiceNumber.source = 'FOUND';
  if (issueDate.value) issueDate.source = 'FOUND';
  if (!issueDate.value) {
    // a line labelled just "Date"
    for (const l of lines) {
      const v = afterLabel(l, ['date']);
      const ll = l.toLowerCase();
      if (v !== null && !ll.includes('due') && !ll.includes('delivery') && !ll.includes('order')) {
        const d = readDate(v);
        if (d) {
          issueDate.value = d;
          issueDate.source = 'GUESSED';
          break;
        }
      }
    }
  }
  if (dueDate.value) dueDate.source = 'FOUND';
  else if (issueDate.value && terms !== null) {
    dueDate.value = addDays(issueDate.value, terms);
    dueDate.source = 'GUESSED';
  }

  // ---- currency
  const currency: Field<string> = { value: ctx.currency, source: 'GUESSED' };
  const all = text.toLowerCase();
  for (const [mark, code] of CURRENCY_MARKS) {
    const at = all.indexOf(mark);
    if (at >= 0 && (mark.length === 1 || !isLetter(all[at - 1] ?? ' '))) {
      currency.value = code;
      currency.source = 'FOUND';
      break;
    }
  }
  if (currency.source === 'GUESSED' && (all.includes(' rs ') || all.includes('rupees'))) {
    currency.value = 'INR';
    currency.source = 'FOUND';
  }

  // ---- line items
  const items: ExtractedBillLine[] = [];
  const headerAt = lower.findIndex((l) => HEADER_ITEM.some((w) => l.includes(w)) && HEADER_FIGURE.some((w) => l.includes(w)) && HEADER_QTY.some((w) => l.includes(w)));
  if (headerAt >= 0) {
    const header = lower[headerAt]!;
    const hasHsn = header.includes('hsn') || header.includes('sac');
    for (let i = headerAt + 1; i < lines.length && items.length < 200; i++) {
      const l = lines[i]!;
      const ll = lower[i]!;
      if (!l.trim()) continue;
      if (isStopLine(ll.trim())) break;
      const ws = words(l);
      // trailing figures
      let k = ws.length;
      while (k > 0 && (readAmount(ws[k - 1]!) || readPercent(ws[k - 1]!) || ws[k - 1] === '%' || ['nos', 'pcs', 'hrs', 'kg', 'units', 'unit', 'no', 'pc', 'each', 'ea', 'm', 'ltr'].includes(ws[k - 1]!.toLowerCase().replace('.', '')))) k--;
      let desc = ws.slice(0, k);
      const figs = ws.slice(k);
      if (!figs.length || !desc.some(hasLetter)) {
        // a description carried onto the next line
        const prev = items[items.length - 1];
        if (prev && !figs.length && hasLetter(l) && prev.description.length < 200) prev.description = `${prev.description} ${l.trim()}`.slice(0, 200);
        continue;
      }
      if (desc.length > 1 && /^\d{1,3}[.)]?$/.test(desc[0]!)) desc = desc.slice(1);
      let hsn: string | null = null;
      const nums: { v: Dec; raw: string }[] = [];
      for (let j = 0; j < figs.length; j++) {
        const f = figs[j]!;
        if (readPercent(f, figs[j + 1]) || f === '%') continue;
        const a = readAmount(f);
        if (!a) continue;
        if (hasHsn && !hsn && nums.length === 0 && f.length >= 4 && f.length <= 8 && [...f].every(isDigitCh)) {
          hsn = f;
          continue;
        }
        nums.push({ v: a, raw: f });
      }
      if (!nums.length) continue;
      let q: Dec | null = null;
      let r: Dec | null = null;
      let a: Dec = nums[nums.length - 1]!.v;
      for (let j = 0; j + 2 < nums.length; j++) {
        const [x, y, z] = [nums[j]!.v, nums[j + 1]!.v, nums[j + 2]!.v];
        if (x.greaterThan(0) && x.times(y).minus(z).abs().lessThanOrEqualTo(new D('0.01').times(D.max(1, x)))) {
          q = x;
          r = y;
          a = z;
          break;
        }
      }
      if (!q && nums.length === 2 && nums[0]!.v.greaterThan(0) && !nums[0]!.v.isZero()) {
        // "Qty Amount": the rate is the amount over the quantity when it divides exactly
        const [x, z] = [nums[0]!.v, nums[1]!.v];
        const unit = z.dividedBy(x);
        if (unit.decimalPlaces() <= 2 && x.isInteger()) {
          q = x;
          r = unit;
          a = z;
        }
      }
      if (a.lessThanOrEqualTo(0)) continue;
      items.push({ description: desc.join(' ').slice(0, 200), hsnCode: hsn, quantity: (q ?? new D(1)).toString(), unitPrice: (r ?? a).toFixed(2), amount: a.toFixed(2), sourceLine: i + 1 });
    }
  }

  // ---- totals and taxes
  let subtotal: Dec | null = null;
  let total: Dec | null = null;
  let totalRank = Infinity;
  let rounding: Dec | null = null;
  let taxTotalLine: Dec | null = null;
  const taxes: ExtractedTax[] = [];
  lines.forEach((l, i) => {
    const ll = lower[i]!.trim();
    if (i === headerAt || items.some((it) => it.sourceLine === i + 1)) return;
    const amount = lastAmount(l);
    if (!amount) return;
    if (ROUND_LABELS.some((x) => ll.includes(x))) {
      rounding = amount;
      return;
    }
    if (isTaxLine(ll)) {
      if (ll.includes('total')) {
        taxTotalLine = amount;
        return;
      }
      const ws = words(l);
      let rate: Dec | null = null;
      for (let j = 0; j < ws.length; j++) {
        const p = readPercent(ws[j]!, ws[j + 1]);
        if (p) {
          rate = p;
          break;
        }
        // "CGST @ 9" written without the sign
        if (ws[j] === '@' && ws[j + 1] && readAmount(ws[j + 1]!) && j + 2 < ws.length) {
          rate = readAmount(ws[j + 1]!.replace('%', ''));
          break;
        }
      }
      const label = TAX_WORDS.find((t) => ll.includes(t))!.toUpperCase();
      if (taxes.length < 10) taxes.push({ label, rate: rate ? rate.toString() : null, amount: amount.toFixed(2) });
      return;
    }
    if (!subtotal && SUBTOTAL_LABELS.some((x) => afterLabel(ll, [x]) !== null)) {
      subtotal = amount;
      return;
    }
    const rank = TOTAL_LABELS.findIndex((x) => afterLabel(ll, [x]) !== null && (x !== 'total' || ll.startsWith('total')));
    if (rank >= 0 && !ll.includes('qty') && !ll.includes('quantity') && rank <= totalRank) {
      total = amount;
      totalRank = rank;
    }
  });
  const taxSum = taxes.length ? taxes.reduce((s, t) => s.plus(t.amount), new D(0)) : null;
  const taxTotal: Dec | null = taxSum ?? taxTotalLine;
  const itemsSum = items.reduce((s, it) => s.plus(it.amount), new D(0));

  let linesFrom: ExtractedBill['linesFrom'] = items.length ? 'TABLE' : 'NONE';
  const sub = subtotal as Dec | null;
  const tot = total as Dec | null;
  const rnd = rounding as Dec | null;
  if (!items.length) {
    const base = sub ?? (tot && taxTotal ? tot.minus(taxTotal).minus(rnd ?? 0) : tot);
    if (base && base.greaterThan(0)) {
      items.push({ description: invoiceNumber.value ? `Bill ${invoiceNumber.value}` : 'Bill', hsnCode: null, quantity: '1', unitPrice: base.toFixed(2), amount: base.toFixed(2), sourceLine: 0 });
      linesFrom = 'TOTAL_ONLY';
      checks.push('No table of items was found; one line for the amount before tax was used. Split it if the bill covers several things');
    }
  }

  // ---- the tax rate across the bill
  const taxPercent: Field<string> = { value: null, source: 'MISSING' };
  const rates = new Set<string>();
  const cg = taxes.filter((t) => t.label === 'CGST' || t.label === 'SGST' || t.label === 'UTGST');
  for (const t of taxes) if ((t.label === 'IGST' || t.label === 'GST' || t.label === 'VAT') && t.rate) rates.add(new D(t.rate).toString());
  if (cg.length && cg.every((t) => t.rate)) {
    const perHalf = new Set(cg.map((t) => new D(t.rate!).toString()));
    if (perHalf.size === 1) rates.add(new D([...perHalf][0]!).times(2).toString());
    else rates.add('mixed');
  }
  if (rates.size === 1 && !rates.has('mixed')) {
    taxPercent.value = [...rates][0]!;
    taxPercent.source = 'FOUND';
  } else if (!rates.size && taxTotal && (sub ?? (items.length ? itemsSum : null))) {
    const base = sub ?? itemsSum;
    if (base.greaterThan(0)) {
      const pct = taxTotal.dividedBy(base).times(100);
      const near = ['0', '3', '5', '12', '18', '28', '20', '10', '9', '8', '7', '15'].find((s) => pct.minus(s).abs().lessThan('0.05'));
      if (near) {
        taxPercent.value = near;
        taxPercent.source = 'GUESSED';
      }
    }
  }
  if (!taxes.length && !taxTotal) {
    taxPercent.value = null;
    taxPercent.source = 'MISSING';
  }

  // ---- checks
  if (supplierSource === 'MISSING') checks.push('The supplier could not be found on the bill; choose the supplier');
  else if (!contact) checks.push(`${supplierName} is not one of your vendors yet; choose the vendor or add them first`);
  if (!invoiceNumber.value) checks.push("The bill number could not be found; enter the supplier's bill number");
  if (!issueDate.value) checks.push('The bill date could not be found; enter it');
  if (issueDate.value && issueDate.value > ctx.today) checks.push(`The bill date ${issueDate.value} is in the future; check it`);
  if (issueDate.value && dueDate.value && dueDate.value < issueDate.value) checks.push(`The due date ${dueDate.value} is before the bill date ${issueDate.value}`);
  if (!tot) checks.push("The bill's total could not be found; check the amounts against the bill");
  if (linesFrom === 'TABLE' && sub && !itemsSum.equals(sub)) checks.push(`The items add up to ${itemsSum.toFixed(2)}, but the bill's subtotal is ${sub.toFixed(2)}; check the items`);
  const before = linesFrom === 'TABLE' ? (sub ?? itemsSum) : sub;
  if (tot && before) {
    const expect = before.plus(taxTotal ?? 0).plus(rnd ?? 0);
    if (!expect.equals(tot)) checks.push(`The subtotal${taxTotal ? ' plus tax' : ''}${rnd ? ' and rounding' : ''} comes to ${expect.toFixed(2)}, but the bill's total is ${tot.toFixed(2)}`);
  }
  if (rates.has('mixed') || (rates.size > 1 && !rates.has('mixed'))) checks.push('The bill has more than one tax rate; set the tax on each line');

  return {
    supplier: { name: supplierName, taxId: supplierTaxId, contactId: contact?.id ?? null, matchedBy, source: supplierSource },
    buyerTaxId,
    invoiceNumber,
    issueDate,
    dueDate,
    currency,
    lines: items,
    linesFrom,
    subtotal: sub ? sub.toFixed(2) : null,
    taxes,
    taxTotal: taxTotal ? taxTotal.toFixed(2) : null,
    rounding: rnd ? rnd.toFixed(2) : null,
    total: tot ? tot.toFixed(2) : null,
    taxPercent,
    checks,
  };
}
