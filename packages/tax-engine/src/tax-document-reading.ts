import { D } from '@talk2tax/accounting-engine';
import { checkGstin } from './india/gstin';

/**
 * Tax document interpretation (TAX-043): the text of a tax document someone received (an Indian
 * TDS certificate, the annual tax statement, a GST payment challan, or a US Form 1099) is
 * recognised, its fields are found with the line each came from, what the document is and what to
 * do with it is said in plain words, and the figures are checked against each other and against
 * the business's own identifiers. Deterministic: nothing is guessed or invented. A field that is
 * not found is reported as not found. The explanations were written from published forms as known
 * on TAX_DOCUMENTS_CHECKED_ON and need review by a tax adviser.
 */

export const TAX_DOCUMENTS_CHECKED_ON = '2026-11-24';

export const TAX_DOCUMENT_KINDS = ['TDS_CERTIFICATE', 'ANNUAL_TAX_STATEMENT', 'GST_CHALLAN', 'FORM_1099', 'UNKNOWN'] as const;
export type TaxDocumentKind = (typeof TAX_DOCUMENT_KINDS)[number];

export const TAX_DOCUMENT_GUIDE: Readonly<Record<TaxDocumentKind, { title: string; what: string; todo: string }>> = {
  TDS_CERTIFICATE: {
    title: 'TDS certificate (Form 16A)',
    what: 'A customer (the deductor) deducted income tax at source from a payment to you and deposited it with the government. The certificate is your proof of that tax credit for the quarter.',
    todo: 'Check that your PAN is right and that the tax matches what the customer kept back from your invoices. Book it to your TDS receivable account if not already, and claim it in your income tax return.',
  },
  ANNUAL_TAX_STATEMENT: {
    title: 'Annual tax statement (Form 26AS or AIS)',
    what: "The income tax department's statement of tax credited to your PAN for a year: tax deducted at source by each deductor, and tax you paid yourself.",
    todo: 'Compare the tax deducted by each deductor with your TDS receivable account. Ask any customer whose figure is missing or lower to correct their TDS return, because only tax shown here can be claimed.',
  },
  GST_CHALLAN: {
    title: 'GST payment challan (GST PMT-06)',
    what: 'A challan generated on the GST portal to pay GST into the electronic cash ledger, split into IGST, CGST, SGST/UTGST and cess with tax, interest, penalty, fee and other heads.',
    todo: 'Check the GSTIN is yours and that the amounts match what the GST return needs. Once paid (the challan shows a CIN), record the payment against the return.',
  },
  FORM_1099: {
    title: 'US Form 1099 received',
    what: 'A US payer reported to the IRS what it paid you in the year: services on Form 1099-NEC, rents and other income on Form 1099-MISC.',
    todo: "Check the amount against the payer's invoices you were paid for in the year and that the TIN shown is yours. Report the income on your return; ask the payer for a corrected form if it is wrong.",
  },
  UNKNOWN: {
    title: 'Not recognised',
    what: 'The text does not look like any of the tax documents Talk2Tax can read: a TDS certificate (Form 16A), the annual tax statement (Form 26AS or AIS), a GST challan (PMT-06) or a US Form 1099.',
    todo: 'Check the file is the right document and has text (a scan or photo has none). Tax notices are read on the Tax notices page.',
  },
};

export interface TaxDocumentField {
  key: string;
  label: string;
  value: string;
  /** The line of the document the value was read from. */
  line: string;
}

export interface DeductorEntry {
  name: string;
  tan: string;
  amountPaid: string;
  taxDeducted: string;
  taxDeposited: string | null;
  line: string;
}

export interface TaxDocumentContext {
  ownPan?: string | null;
  ownTan?: string | null;
  ownGstin?: string | null;
  ownEinLast4?: string | null;
  /** TDS in the business's TDS receivable account for the same year, to compare with an annual statement. */
  booksTds?: string | null;
}

export interface TaxDocumentReading {
  kind: TaxDocumentKind;
  title: string;
  what: string;
  todo: string;
  fields: TaxDocumentField[];
  deductors: DeductorEntry[];
  totals: { amountPaid: string | null; taxDeducted: string | null; taxDeposited: string | null; total: string | null };
  checks: { level: 'ERROR' | 'WARNING' | 'OK'; message: string }[];
  checkedOn: string;
}

const PAN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const TAN = /\b[A-Z]{4}[0-9]{5}[A-Z]\b/;
const GSTIN = /\b[0-9]{2}[A-Z0-9]{13}\b/;
const AMOUNT = /[0-9][0-9,]*(?:\.[0-9]{1,2})?/g;
const YEAR_RANGE = /\b(20[0-9]{2})-([0-9]{2})\b/;
const DATE_DMY = /\b([0-3]?[0-9])[-/.]([01]?[0-9])[-/.](20[0-9]{2})\b/;
const DATE_ISO = /\b(20[0-9]{2})-([01][0-9])-([0-3][0-9])\b/;
const CPIN = /\b[0-9]{14}\b/;
const EIN_OR_SSN = /(?<![0-9A-Za-z*])(?:[0-9]{2}-[0-9]{7}|[0-9]{3}-[0-9]{2}-[0-9]{4}|[*Xx]{3}-[*Xx]{2}-[0-9]{4}|[*Xx]{2}-[*Xx]{3}[0-9]{4})(?![0-9])/;

const pad = (n: string) => n.padStart(2, '0');
const money = (s: string) => new D(s.split(',').join('')).toFixed(2);

function amountsIn(text: string): string[] {
  return (text.match(AMOUNT) ?? []).filter((a) => /[.,]/.test(a) || a.length <= 12).map(money);
}

function dateIn(text: string): string | null {
  const iso = DATE_ISO.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = DATE_DMY.exec(text);
  if (!dmy) return null;
  const [, d, m, y] = dmy;
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${pad(m!)}-${pad(d!)}`;
}

/** The text after a label on the line, or (for names) the next line when the label stands alone. */
function after(lines: string[], i: number, labelEnd: number, nextLine: boolean) {
  const rest = lines[i]!.slice(labelEnd).replace(/^[\s:.-]+/, '');
  return rest || (nextLine ? (lines[i + 1] ?? '') : '');
}

export function classifyTaxDocument(text: string): TaxDocumentKind {
  const t = text.toUpperCase();
  if (t.includes('PMT-06') || (t.includes('CPIN') && t.includes('GSTIN'))) return 'GST_CHALLAN';
  if (t.includes('26AS') || t.includes('ANNUAL TAX STATEMENT') || t.includes('ANNUAL INFORMATION STATEMENT')) return 'ANNUAL_TAX_STATEMENT';
  if (t.includes('16A') || t.includes('SECTION 203') || (t.includes('CERTIFICATE') && t.includes('TAX DEDUCTED AT SOURCE'))) return 'TDS_CERTIFICATE';
  if (t.includes('1099-NEC') || t.includes('1099-MISC')) return 'FORM_1099';
  return 'UNKNOWN';
}

interface FieldRule {
  key: string;
  label: string;
  labels: string[];
  read: (s: string) => string | null;
  /** The value may be on the line after a label that stands alone (names). */
  nextLine?: boolean;
  /** The label must start the line (for words that also appear in running text). */
  atStart?: boolean;
  /** Read the whole line rather than the text after the label. */
  wholeLine?: boolean;
}

const first = (re: RegExp) => (s: string) => re.exec(s.toUpperCase())?.[0] ?? null;
const firstAmount = (s: string) => amountsIn(s)[0] ?? null;
const yearRange = (s: string) => {
  const m = YEAR_RANGE.exec(s);
  return m ? `${m[1]}-${m[2]}` : null;
};
const text = (s: string) => s.trim().slice(0, 120) || null;

const RULES: Readonly<Record<Exclude<TaxDocumentKind, 'UNKNOWN'>, FieldRule[]>> = {
  TDS_CERTIFICATE: [
    { key: 'certificateNumber', label: 'Certificate number', labels: ['certificate no', 'certificate number'], read: (s) => /[A-Z0-9]{5,}/.exec(s.toUpperCase())?.[0] ?? null },
    { key: 'deductorName', label: 'Deductor', labels: ['name of the deductor', 'name of deductor'], read: text, nextLine: true },
    { key: 'deductorTan', label: "Deductor's TAN", labels: ['tan of the deductor', 'tan of deductor'], read: first(TAN) },
    { key: 'deducteePan', label: 'Your PAN', labels: ['pan of the deductee', 'pan of deductee'], read: first(PAN) },
    { key: 'assessmentYear', label: 'Assessment year', labels: ['assessment year'], read: yearRange },
    { key: 'taxYear', label: 'Tax year', labels: ['tax year', 'financial year'], read: yearRange },
    { key: 'quarter', label: 'Quarter', labels: ['quarter'], read: (s) => /\bQ[1-4]\b/.exec(s.toUpperCase())?.[0] ?? null },
    { key: 'section', label: 'Section', labels: ['section'], atStart: true, read: (s) => /\b[0-9]{3}[A-Z]{0,2}(?:\([0-9a-z]+\))*/.exec(s)?.[0] ?? null },
    { key: 'amountPaid', label: 'Amount paid or credited', labels: ['amount paid', 'amount credited', 'amount of payment'], read: firstAmount },
    { key: 'taxDeducted', label: 'Tax deducted', labels: ['tax deducted', 'amount of tax deducted'], read: firstAmount },
    { key: 'taxDeposited', label: 'Tax deposited', labels: ['tax deposited', 'amount of tax deposited'], read: firstAmount },
  ],
  ANNUAL_TAX_STATEMENT: [
    { key: 'pan', label: 'PAN', labels: ['permanent account number', 'pan'], read: first(PAN) },
    { key: 'name', label: 'Name', labels: ['name of assessee', 'name of taxpayer', 'name'], read: text, nextLine: true },
    { key: 'assessmentYear', label: 'Assessment year', labels: ['assessment year'], read: yearRange },
    { key: 'taxYear', label: 'Tax year', labels: ['tax year', 'financial year'], read: yearRange },
  ],
  GST_CHALLAN: [
    { key: 'cpin', label: 'CPIN', labels: ['cpin'], read: first(CPIN) },
    { key: 'gstin', label: 'GSTIN', labels: ['gstin'], read: first(GSTIN) },
    { key: 'date', label: 'Challan date', labels: ['challan generated on', 'date of generation', 'challan date', 'date'], read: dateIn },
    { key: 'cin', label: 'CIN (paid)', labels: ['cin'], read: (s) => /\b[A-Z0-9]{17,22}\b/.exec(s.toUpperCase())?.[0] ?? null },
    { key: 'igst', label: 'IGST', labels: ['igst'], read: (s) => amountsIn(s).at(-1) ?? null },
    { key: 'cgst', label: 'CGST', labels: ['cgst'], read: (s) => amountsIn(s).at(-1) ?? null },
    { key: 'sgst', label: 'SGST/UTGST', labels: ['sgst', 'utgst'], read: (s) => amountsIn(s).at(-1) ?? null },
    { key: 'cess', label: 'Cess', labels: ['cess'], read: (s) => amountsIn(s).at(-1) ?? null },
    { key: 'total', label: 'Total challan amount', labels: ['total challan amount', 'total amount'], read: (s) => amountsIn(s).at(-1) ?? null },
  ],
  FORM_1099: [
    { key: 'form', label: 'Form', labels: ['form 1099'], wholeLine: true, read: (s) => /1099-(?:NEC|MISC)/.exec(s.toUpperCase())?.[0] ?? null },
    { key: 'year', label: 'Calendar year', labels: ['calendar year', 'for calendar year', 'tax year'], read: (s) => /\b20[0-9]{2}\b/.exec(s)?.[0] ?? null },
    { key: 'payer', label: 'Payer', labels: ["payer's name", 'payer name'], read: text, nextLine: true },
    { key: 'payerTin', label: "Payer's TIN", labels: ["payer's tin", 'payer tin'], read: (s) => EIN_OR_SSN.exec(s)?.[0] ?? null },
    { key: 'recipientTin', label: 'Your TIN', labels: ["recipient's tin", 'recipient tin'], read: (s) => EIN_OR_SSN.exec(s)?.[0] ?? null },
    { key: 'nonemployeeCompensation', label: 'Box 1 nonemployee compensation', labels: ['nonemployee compensation'], read: firstAmount },
    { key: 'rents', label: 'Box 1 rents', labels: ['rents'], read: firstAmount },
    { key: 'otherIncome', label: 'Box 3 other income', labels: ['other income'], read: firstAmount },
    { key: 'federalTaxWithheld', label: 'Federal income tax withheld', labels: ['federal income tax withheld'], read: firstAmount },
  ],
};

function readFields(kind: Exclude<TaxDocumentKind, 'UNKNOWN'>, lines: string[]): TaxDocumentField[] {
  const out: TaxDocumentField[] = [];
  for (const rule of RULES[kind]) {
    let found: TaxDocumentField | null = null;
    for (let i = 0; i < lines.length && !found; i++) {
      const lower = lines[i]!.toLowerCase();
      for (const label of rule.labels) {
        const at = lower.indexOf(label);
        if (at < 0 || (rule.atStart && at > 0)) continue;
        const value = rule.read(rule.wholeLine ? lines[i]! : after(lines, i, at + label.length, rule.nextLine ?? false));
        if (value) {
          found = { key: rule.key, label: rule.label, value, line: lines[i]!.trim().slice(0, 200) };
          break;
        }
      }
    }
    if (found) out.push(found);
  }
  return out;
}

/** Rows of an annual statement: a deductor's name, TAN, then the amount paid, tax deducted and tax deposited. */
function readDeductors(lines: string[]): DeductorEntry[] {
  const out: DeductorEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = TAN.exec(line.toUpperCase());
    if (!m || /\btan of\b/i.test(line)) continue;
    const name = line
      .slice(0, m.index)
      .replace(/^[0-9]+[.)]?\s/, '')
      .split('|')
      .join(' ')
      .trim();
    const amounts = amountsIn(line.slice(m.index + m[0].length));
    if (!name || amounts.length < 2) continue;
    out.push({ name: name.slice(0, 120), tan: m[0], amountPaid: amounts[0]!, taxDeducted: amounts[1]!, taxDeposited: amounts[2] ?? null, line: line.slice(0, 200) });
  }
  return out;
}

/**
 * The financial (tax) year a reading is for, as 2026-27: the tax year when the document gives one,
 * else the year before its assessment year.
 */
export function taxDocumentYear(r: Pick<TaxDocumentReading, 'fields'>): string | null {
  const v = (k: string) => r.fields.find((f) => f.key === k)?.value ?? null;
  const ty = v('taxYear');
  if (ty) return ty;
  const ay = v('assessmentYear');
  if (!ay) return null;
  const start = Number(ay.slice(0, 4)) - 1; // not money
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`; // not money
}

export function readTaxDocument(input: string, ctx: TaxDocumentContext = {}): TaxDocumentReading {
  const lines = input
    .split('\u0000')
    .join('')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5000);
  const kind = classifyTaxDocument(input);
  const guide = TAX_DOCUMENT_GUIDE[kind];
  const fields = kind === 'UNKNOWN' ? [] : readFields(kind, lines);
  const deductors = kind === 'ANNUAL_TAX_STATEMENT' ? readDeductors(lines) : [];
  const f = (k: string) => fields.find((x) => x.key === k)?.value ?? null;
  const checks: TaxDocumentReading['checks'] = [];
  const totals: TaxDocumentReading['totals'] = { amountPaid: null, taxDeducted: null, taxDeposited: null, total: null };

  if (kind === 'TDS_CERTIFICATE') {
    totals.amountPaid = f('amountPaid');
    totals.taxDeducted = f('taxDeducted');
    totals.taxDeposited = f('taxDeposited');
    const pan = f('deducteePan');
    if (!pan) checks.push({ level: 'WARNING', message: 'Your PAN was not found on the certificate.' });
    else if (ctx.ownPan && pan !== ctx.ownPan)
      checks.push({ level: 'ERROR', message: `The certificate is for PAN ${pan}, not your PAN ${ctx.ownPan}. The credit will not reach you until the deductor corrects it.` });
    else if (ctx.ownPan) checks.push({ level: 'OK', message: 'The certificate is for your PAN.' });
    if (totals.amountPaid && totals.taxDeducted) {
      const paid = new D(totals.amountPaid);
      const tax = new D(totals.taxDeducted);
      if (tax.gt(paid)) checks.push({ level: 'ERROR', message: 'The tax deducted is more than the amount paid, so a figure was read wrongly or the certificate is wrong.' });
      else if (paid.gt(0))
        checks.push({ level: 'OK', message: `Tax deducted is ${tax.div(paid).times(100).toDecimalPlaces(2).toFixed()}% of the amount paid. Check this is the rate for the section.` });
    }
    if (totals.taxDeducted && totals.taxDeposited && !new D(totals.taxDeducted).equals(totals.taxDeposited))
      checks.push({ level: 'WARNING', message: 'Less tax was deposited than deducted. Only the deposited tax can be claimed; ask the deductor to deposit the rest.' });
  }

  if (kind === 'ANNUAL_TAX_STATEMENT') {
    const sum = (k: 'amountPaid' | 'taxDeducted') => deductors.reduce((s, d) => s.plus(d[k]), new D(0));
    if (deductors.length) {
      totals.amountPaid = sum('amountPaid').toFixed(2);
      totals.taxDeducted = sum('taxDeducted').toFixed(2);
      const dep = deductors.filter((d) => d.taxDeposited !== null);
      totals.taxDeposited = dep.length ? dep.reduce((s, d) => s.plus(d.taxDeposited!), new D(0)).toFixed(2) : null;
    } else checks.push({ level: 'WARNING', message: 'No deductor rows (a name, a TAN and amounts on one line) were found.' });
    const pan = f('pan');
    if (pan && ctx.ownPan && pan !== ctx.ownPan) checks.push({ level: 'ERROR', message: `The statement is for PAN ${pan}, not your PAN ${ctx.ownPan}.` });
    for (const d of deductors)
      if (new D(d.taxDeducted).gt(d.amountPaid)) checks.push({ level: 'ERROR', message: `${d.name}: the tax deducted is more than the amount paid; check the row was read correctly.` });
    if (totals.taxDeducted && ctx.booksTds != null) {
      const diff = new D(totals.taxDeducted).minus(ctx.booksTds);
      if (diff.isZero()) checks.push({ level: 'OK', message: 'The TDS on the statement matches your TDS receivable account for the year.' });
      else if (diff.gt(0))
        checks.push({ level: 'WARNING', message: `The statement shows ${diff.toFixed(2)} more TDS than your TDS receivable account. Book the TDS customers deducted, or check the year.` });
      else
        checks.push({
          level: 'ERROR',
          message: `Your TDS receivable account has ${diff.negated().toFixed(2)} more than the statement. That credit cannot be claimed until the deductors file or correct their TDS returns.`,
        });
    }
  }

  if (kind === 'GST_CHALLAN') {
    const gstin = f('gstin');
    totals.total = f('total');
    if (gstin) {
      const g = checkGstin(gstin);
      if (!g.valid) checks.push({ level: 'ERROR', message: `The GSTIN ${gstin} on the challan is not valid: ${g.issues.join('; ')}.` });
      else if (ctx.ownGstin && gstin !== ctx.ownGstin)
        checks.push({ level: 'ERROR', message: `The challan is for GSTIN ${gstin}, not yours (${ctx.ownGstin}). The payment would go to another ledger.` });
      else if (ctx.ownGstin) checks.push({ level: 'OK', message: 'The challan is for your GSTIN.' });
    } else checks.push({ level: 'WARNING', message: 'No GSTIN was found on the challan.' });
    const parts = ['igst', 'cgst', 'sgst', 'cess'].map(f).filter((x): x is string => x !== null);
    if (totals.total && parts.length) {
      const sum = parts.reduce((s, p) => s.plus(p), new D(0));
      if (!sum.equals(totals.total)) checks.push({ level: 'WARNING', message: `The heads add up to ${sum.toFixed(2)}, not the total ${totals.total}. Check the challan was read correctly.` });
      else checks.push({ level: 'OK', message: 'The tax heads add up to the total.' });
    }
    if (!f('cin')) checks.push({ level: 'WARNING', message: 'No CIN was found, so the challan may not be paid yet. A paid challan carries the bank’s CIN.' });
  }

  if (kind === 'FORM_1099') {
    totals.total = f('nonemployeeCompensation') ?? f('rents') ?? f('otherIncome');
    const tin = f('recipientTin');
    const last4 = tin ? tin.slice(-4) : null;
    if (last4 && ctx.ownEinLast4 && last4 !== ctx.ownEinLast4) checks.push({ level: 'ERROR', message: `The recipient TIN ends ${last4}, not ${ctx.ownEinLast4}. Ask the payer for a corrected form.` });
    if (f('federalTaxWithheld') && !new D(f('federalTaxWithheld')!).isZero())
      checks.push({ level: 'WARNING', message: 'Federal income tax was withheld (backup withholding). Claim it on your return and give the payer a W-9 to stop it.' });
    if (!totals.total) checks.push({ level: 'WARNING', message: 'No amount was found in box 1 or box 3.' });
  }

  return { kind, title: guide.title, what: guide.what, todo: guide.todo, fields, deductors, totals, checks, checkedOn: TAX_DOCUMENTS_CHECKED_ON };
}
