import { D } from '@talk2tax/accounting-engine';
import { checkGstin } from './india/gstin';

/**
 * Reading a receipt (EXP-004). Talk2Tax turns a receipt photo into text with OCR (or takes the text
 * layer of a PDF) and this module picks out what an expense needs: who was paid, the date, the
 * total, the tax (GST, VAT, cess) and the supplier's GSTIN. Every value says how sure the reading
 * is and the line it came from, and the reading checks itself (the subtotal and tax add up to the
 * total, the GSTIN's check character, the date is not in the future). Nothing is saved from a
 * reading: it fills a form the member checks before saving. The patterns are deterministic and
 * bounded, with no backtracking on the receipt's text.
 */

export type ReadConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export interface ReadField {
  value: string;
  confidence: ReadConfidence;
  /** The receipt line the value was read from. */
  line: string;
}
export interface ReceiptTaxLine {
  label: string;
  rate: string | null;
  amount: string;
  line: string;
}
export interface ReceiptReading {
  merchant: ReadField | null;
  date: ReadField | null;
  total: ReadField | null;
  subtotal: ReadField | null;
  taxes: ReceiptTaxLine[];
  /** Sum of the tax lines, or null when none was read. */
  taxTotal: string | null;
  gstin: ReadField | null;
  gstinIssues: string[];
  currency: string | null;
  /** Whether the subtotal plus tax equals the total (within 1.00 for rounding); null when not all three were read. */
  addsUp: boolean | null;
  warnings: string[];
}

const MAX_LINES = 400; // not money
const MAX_LINE = 200; // not money
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Amounts such as 1,180.50, 1,23,456.00, 420 or 420.5; a trailing ".-" or "/-" is allowed. */
const AMOUNT = /(?<![\d.,])(\d{1,3}(?:,\d{2,3}){1,4}|\d{1,9})(?:\.(\d{1,2}))?(?![\d,]|\.\d)/g;
const PERCENT = /(\d{1,2}(?:\.\d{1,2})?)\s?%/;
const GSTIN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3})\b/;
const NUMERIC_DATE = /\b(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})\b/;
const WORD_DATE = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]{1,2}([A-Za-z]{3,9})[\s,-]{1,3}(\d{2,4})\b/;
const WORD_DATE_US = /\b([A-Za-z]{3,9})\s(\d{1,2}),?\s(\d{4})\b/;

const TOTAL_WORDS: [RegExp, number][] = [
  [/\bgrand\s?total\b/i, 5],
  [/\b(?:net\s(?:amount|payable|total)|amount\s(?:payable|due|paid)|total\s(?:payable|due|amount|paid)|bill\samount|invoice\s(?:total|amount))\b/i, 4],
  [/\btotal\b/i, 2],
];
const NOT_TOTAL = /\b(?:sub\s?-?\s?total|total\s(?:tax|gst|vat|qty|quantity|items?|savings?|discount)|items?\stotal|taxable)\b/i;
const SUBTOTAL = /\b(?:sub\s?-?\s?total|taxable\s(?:value|amount)|amount\sbefore\stax|net\sbefore\stax)\b/i;
const TAX_LABEL = /\b(cgst|sgst|utgst|igst|gst|vat|cess|sales\stax|tax)\b/i;
const NOT_TAX = /\b(?:gstin|gst\s?(?:no|number|reg)|vat\s?(?:no|number|reg)|tax\s?invoice|incl(?:uding|usive|\.)?|total\s(?:tax|gst)|tax\sid|taxable|pan)\b/i;
const NOT_MERCHANT = /\b(?:tax\sinvoice|invoice|receipt|bill\s?(?:no|number)?|cash\smemo|gstin|date|time|tel|phone|ph|mob|mobile|email|www|http|order|table|cashier|token|welcome)\b/i;

const clean = (line: string) => line.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);

function amountsIn(line: string): { value: string; at: number }[] {
  const out: { value: string; at: number }[] = [];
  for (const m of line.matchAll(AMOUNT)) {
    // Skip the number of a percentage, such as the 9 in "CGST 9%".
    const after = line.slice(m.index! + m[0].length, m.index! + m[0].length + 2).trimStart();
    if (after.startsWith('%')) continue;
    const whole = m[1]!.split(',').join('');
    out.push({ value: new D(`${whole}.${(m[2] ?? '').padEnd(2, '0')}`).toFixed(2), at: m.index! });
  }
  return out;
}
/** Drop decoration such as "*** " or " ---" around a name, without a regex. */
function trimPunctuation(line: string): string {
  const keep = (c: string) => /[A-Za-z0-9&().']/.test(c);
  let a = 0;
  let b = line.length;
  while (a < b && !keep(line[a]!)) a++;
  while (b > a && !keep(line[b - 1]!)) b--;
  return line.slice(a, b);
}
const lastAmount = (line: string) => amountsIn(line).at(-1)?.value ?? null;

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}
const monthOf = (word: string) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;

/** A date on a line, and whether it could be read two ways (03/04 as 3 April or 4 March). */
function dateIn(line: string, dayFirst: boolean): { iso: string; ambiguous: boolean } | null {
  const n = NUMERIC_DATE.exec(line);
  if (n) {
    const [a, b, c] = [Number(n[1]), Number(n[2]), Number(n[3])];
    if (n[1]!.length === 4) {
      const iso = isoDate(a, b, c);
      if (iso) return { iso, ambiguous: false };
    } else if (n[3]!.length !== 3) {
      const first = dayFirst ? isoDate(c, b, a) : isoDate(c, a, b);
      const other = dayFirst ? isoDate(c, a, b) : isoDate(c, b, a);
      if (first) return { iso: first, ambiguous: !!other && other !== first };
      if (other) return { iso: other, ambiguous: false };
    }
  }
  const w = WORD_DATE.exec(line);
  if (w && monthOf(w[2]!) > 0) {
    const iso = isoDate(Number(w[3]), monthOf(w[2]!), Number(w[1]));
    if (iso) return { iso, ambiguous: false };
  }
  const u = WORD_DATE_US.exec(line);
  if (u && monthOf(u[1]!) > 0) {
    const iso = isoDate(Number(u[3]), monthOf(u[1]!), Number(u[2]));
    if (iso) return { iso, ambiguous: false };
  }
  return null;
}

function currencyOf(text: string): string | null {
  if (text.includes('₹') || /\b(?:rs\.?|inr)(?=[\s\d.])/i.test(text)) return 'INR';
  if (text.includes('€') || /\beur\b/i.test(text)) return 'EUR';
  if (text.includes('£') || /\bgbp\b/i.test(text)) return 'GBP';
  if (text.includes('$') || /\busd\b/i.test(text)) return 'USD';
  return null;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000); // not money

/**
 * Read a receipt's text. `today` (YYYY-MM-DD) is used to reject dates in the future; `dayFirst`
 * (default true, as in India and Europe) decides how 03/04/2026 is read.
 */
export function readReceipt(text: string, options: { today: string; dayFirst?: boolean }): ReceiptReading {
  const dayFirst = options.dayFirst ?? true;
  const lines = text.slice(0, 50_000).split(/\r?\n/).map(clean).filter(Boolean).slice(0, MAX_LINES);
  const warnings: string[] = [];

  // GSTIN: the first one shaped like a GSTIN, checked.
  let gstin: ReadField | null = null;
  let gstinIssues: string[] = [];
  for (const line of lines) {
    const m = GSTIN.exec(line.toUpperCase());
    if (!m) continue;
    const check = checkGstin(m[1]!);
    gstin = { value: check.gstin, confidence: check.valid ? 'HIGH' : 'LOW', line };
    gstinIssues = check.issues;
    if (!check.valid) warnings.push(`The GSTIN ${check.gstin} does not check out (${check.issues.join('; ')}); it may have been misread`);
    break;
  }

  // Merchant: the first line near the top that reads like a name.
  let merchant: ReadField | null = null;
  for (const line of lines.slice(0, 6)) {
    const letters = line.replace(/[^A-Za-z]/g, '').length;
    if (letters < 3 || letters < line.replace(/\s/g, '').length / 2 || NOT_MERCHANT.test(line) || GSTIN.test(line.toUpperCase()) || amountsIn(line).length > 1) continue;
    merchant = { value: trimPunctuation(line), confidence: 'MEDIUM', line };
    break;
  }

  // Date: a line that says "date" first, then any line.
  let date: ReadField | null = null;
  const dated = [...lines.filter((l) => /\b(?:date|dt|dated)\b/i.test(l)), ...lines];
  for (const line of dated) {
    const d = dateIn(line, dayFirst);
    if (!d) continue;
    if (daysBetween(options.today, d.iso) > 0) {
      warnings.push(`The date read (${d.iso}) is after today; check it`);
      continue;
    }
    date = { value: d.iso, confidence: d.ambiguous ? 'MEDIUM' : 'HIGH', line };
    if (d.ambiguous) warnings.push(`The date ${line.match(NUMERIC_DATE)?.[0] ?? ''} could be read either way; it was read ${dayFirst ? 'day first' : 'month first'}`);
    else if (daysBetween(d.iso, options.today) > 365) warnings.push('The receipt is more than a year old');
    break;
  }

  // Subtotal and tax lines.
  let subtotal: ReadField | null = null;
  const taxes: ReceiptTaxLine[] = [];
  for (const line of lines) {
    if (!subtotal && SUBTOTAL.test(line)) {
      const v = lastAmount(line);
      if (v) subtotal = { value: v, confidence: 'HIGH', line };
      continue;
    }
    const label = TAX_LABEL.exec(line);
    if (!label || NOT_TAX.test(line) || GSTIN.test(line.toUpperCase())) continue;
    const v = lastAmount(line);
    if (!v || new D(v).isZero()) continue;
    taxes.push({ label: label[1]!.toUpperCase().replace(/\s+/g, ' '), rate: PERCENT.exec(line)?.[1] ?? null, amount: v, line });
  }
  const taxTotal = taxes.length ? taxes.reduce((s, t) => s.plus(t.amount), new D(0)).toFixed(2) : null;

  // Total: the strongest total word, the last such line on ties (totals come after items).
  let best: { line: string; value: string; weight: number } | null = null;
  for (const line of lines) {
    if (NOT_TOTAL.test(line)) continue;
    const weight = TOTAL_WORDS.find(([re]) => re.test(line))?.[1];
    const value = weight ? lastAmount(line) : null;
    if (weight && value && (!best || weight >= best.weight)) best = { line, value, weight };
  }
  let total: ReadField | null = null;
  let addsUp: boolean | null = null;
  if (best) {
    if (subtotal && taxTotal) addsUp = new D(subtotal.value).plus(taxTotal).minus(best.value).abs().lte(1);
    total = { value: best.value, confidence: addsUp === false ? 'MEDIUM' : best.weight >= 4 || addsUp ? 'HIGH' : 'MEDIUM', line: best.line };
    if (addsUp === false) warnings.push(`The subtotal ${subtotal!.value} and tax ${taxTotal} do not add up to the total ${best.value}; check the total`);
  } else {
    // No total line: the largest amount on the receipt, marked as a guess.
    let largest: { value: string; line: string } | null = null;
    for (const line of lines)
      for (const a of amountsIn(line))
        if (
          !dateIn(line, dayFirst) &&
          !GSTIN.test(line.toUpperCase()) &&
          !/\b(?:tel|phone|ph|mob|mobile|bill\s?no|invoice\s?no|order|table|token)\b/i.test(line) &&
          (!largest || new D(a.value).gt(largest.value))
        )
          largest = { value: a.value, line };
    if (largest) {
      total = { value: largest.value, confidence: 'LOW', line: largest.line };
      warnings.push('No line says "total"; the largest amount was taken as the total');
    }
  }
  if (!total) warnings.push('No amount could be read');
  if (!date) warnings.push('No date could be read');
  if (!merchant) warnings.push('The merchant could not be read');

  return { merchant, date, total, subtotal, taxes, taxTotal, gstin, gstinIssues, currency: currencyOf(text.slice(0, 50_000)), addsUp, warnings };
}
