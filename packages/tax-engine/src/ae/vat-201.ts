import { D, type Dec } from '@talk2tax/accounting-engine';
import { recentVatPeriods, type VatEntry, type VatRateInfo, type VatStagger, type VatTreatment, vatPeriodFor } from '../uk/vat-return';

/**
 * The UAE VAT return, form VAT 201 (TAX-033), prepared from the books on the accruals basis, with
 * the TRN check, the due date (28 days after the tax period) and the Federal Tax Authority's
 * limit for correcting an error on the next return instead of a voluntary disclosure.
 *
 * The same lines as the other returns go in (invoices and credit notes, bills and vendor credits,
 * approved expense claims; voids taken off in the period of the void), with these treatments:
 * standard-rated (5%), zero-rated, exempt and out of scope.
 *
 *   1a-1g standard-rated supplies by emirate, amount and VAT: every supply in the emirate the
 *         business is established in (the emirate of each supply is not recorded);
 *   4 zero-rated supplies; 5 exempt supplies; 8 total supplies and output VAT;
 *   9 standard-rated expenses and recoverable VAT; 11 total expenses and VAT;
 *   12 total VAT due; 13 total recoverable VAT; 14 payable (or repayable) VAT: 12 less 13.
 *
 * Not modelled and left off the return: tourist refunds (2), the reverse charge (3, 10), imports
 * (6, 7), the profit margin scheme, partial exemption and blocked input VAT (such as entertainment
 * and some motor vehicles), and the place of supply of each sale.
 */

export const AE_VAT_TREATMENTS = ['STANDARD', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'] as const satisfies readonly VatTreatment[];
export const AE_TREATMENT_LABEL: Record<VatTreatment, string> = { STANDARD: 'Standard-rated (5%)', REDUCED: 'Reduced rate', ZERO: 'Zero-rated', EXEMPT: 'Exempt', OUTSIDE_SCOPE: 'Out of scope' };
export const AE_VAT_RATE = '5';
/** FTA: an error whose tax difference is AED 10,000 or less may be corrected on the next return; above it, a voluntary disclosure (Form 211). */
export const AE_CORRECTION_LIMIT = '10000';

export const AE_EMIRATES = [
  { key: 'AD', label: 'Abu Dhabi', box: '1a' },
  { key: 'DU', label: 'Dubai', box: '1b' },
  { key: 'SH', label: 'Sharjah', box: '1c' },
  { key: 'AJ', label: 'Ajman', box: '1d' },
  { key: 'UQ', label: 'Umm Al Quwain', box: '1e' },
  { key: 'RK', label: 'Ras Al Khaimah', box: '1f' },
  { key: 'FU', label: 'Fujairah', box: '1g' },
] as const;
export type AeEmirate = (typeof AE_EMIRATES)[number]['key'];

export const AE_VAT201_LABEL: Record<string, string> = {
  ...Object.fromEntries(AE_EMIRATES.flatMap((e) => [[e.box, `Standard rated supplies in ${e.label}: amount`], [`${e.box}-vat`, `Standard rated supplies in ${e.label}: VAT`]])),
  '4': 'Zero rated supplies',
  '5': 'Exempt supplies',
  '8': 'Totals: supplies',
  '8-vat': 'Totals: VAT on supplies',
  '9': 'Standard rated expenses: amount',
  '9-vat': 'Standard rated expenses: recoverable VAT',
  '11': 'Totals: expenses',
  '11-vat': 'Totals: recoverable VAT on expenses',
  '12': 'Total value of due tax for the period',
  '13': 'Total value of recoverable tax for the period',
  '14': 'Payable tax for the period (12 less 13)',
};

/** The boxes in the order of the form (object keys that look like numbers would sort first). */
export const AE_VAT201_ORDER: readonly string[] = [...AE_EMIRATES.flatMap((e) => [e.box, `${e.box}-vat`]), '4', '5', '8', '8-vat', '9', '9-vat', '11', '11-vat', '12', '13', '14'];

/** A tax registration number: 15 digits beginning 100. Spaces and dashes allowed. Returns the digits or null. */
export function normaliseTrn(input: string): string | null {
  const s = input.replace(/[\s-]/g, '');
  return /^100\d{12}$/.test(s) ? s : null;
}

export function suggestAeTreatment(rate: string, name: string): VatTreatment | null {
  const r = new D(rate);
  const n = name.toLowerCase();
  if (r.eq(AE_VAT_RATE)) return 'STANDARD';
  if (!r.isZero()) return null;
  if (n.includes('exempt')) return 'EXEMPT';
  if (n.includes('out of scope') || n.includes('outside') || n.includes('no vat')) return 'OUTSIDE_SCOPE';
  return 'ZERO';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The return and payment are due 28 days after the tax period ends. */
export function aeVatDueDate(end: string) {
  const d = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10)) + 28)); // not money: calendar
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function aeVatPeriodFor(stagger: VatStagger, end: string) {
  const p = vatPeriodFor(stagger, end);
  return p ? { ...p, due: aeVatDueDate(end) } : null;
}

export function recentAeVatPeriods(stagger: VatStagger, today: string, count: number) {
  return recentVatPeriods(stagger, today, count).map((p) => ({ ...p, due: aeVatDueDate(p.end) }));
}

const SALES = new Set(['INVOICE', 'CREDIT_NOTE']);
const NEGATIVE = new Set(['CREDIT_NOTE', 'VENDOR_CREDIT']);

/** The VAT 201 boxes for a period. Standard-rated supplies go in the box of the business's emirate. Corrections are output and input VAT of earlier periods, added to boxes 8, 11, 12 and 13. */
export function aeVat201(entries: readonly VatEntry[], rates: readonly VatRateInfo[], opts: { untaxed: VatTreatment; emirate: string | null; corrections?: readonly { output: string; input: string }[] }) {
  const byId = new Map(rates.map((r) => [r.id, r]));
  const v = { standard: new D(0), output: new D(0), zero: new D(0), exempt: new D(0), expenses: new D(0), input: new D(0) };
  const groups = new Map<string, { side: 'SALES' | 'PURCHASES'; treatment: VatTreatment; net: Dec; vat: Dec; lines: number }>();
  const unclassified = new Map<string, { id: string; name: string; rate: string; lines: number; reduced: boolean }>();
  const used = new Set<string>();
  let untaxed = 0; // not money: count
  let taxOnNoTax = 0; // not money: count
  for (const e of entries) {
    const rate = e.taxRateId ? byId.get(e.taxRateId) : undefined;
    if (e.taxRateId) used.add(e.taxRateId);
    let t: VatTreatment | null;
    if (!e.taxRateId) {
      t = opts.untaxed;
      untaxed++;
    } else t = rate ? (rate.treatment ?? suggestAeTreatment(rate.rate, rate.name)) : null;
    if (!t || t === 'REDUCED') {
      const u = unclassified.get(e.taxRateId!) ?? { id: e.taxRateId!, name: rate?.name ?? 'A deleted tax rate', rate: rate?.rate ?? e.rate, lines: 0, reduced: t === 'REDUCED' };
      u.lines++;
      unclassified.set(e.taxRateId!, u);
      continue;
    }
    const sign = (NEGATIVE.has(e.source) ? -1 : 1) * (e.reversal ? -1 : 1); // not money: a direction
    const net = new D(e.net).times(sign);
    const vat = new D(e.vat).times(sign);
    const sales = SALES.has(e.source);
    if (t !== 'STANDARD' && !vat.isZero()) taxOnNoTax++;
    if (sales) {
      if (t === 'STANDARD') {
        v.standard = v.standard.plus(net);
        v.output = v.output.plus(vat);
      } else if (t === 'ZERO') v.zero = v.zero.plus(net);
      else if (t === 'EXEMPT') v.exempt = v.exempt.plus(net);
    } else if (t === 'STANDARD') {
      v.expenses = v.expenses.plus(net);
      v.input = v.input.plus(vat);
    }
    const key = `${sales ? 'SALES' : 'PURCHASES'}:${t}`;
    const g = groups.get(key) ?? { side: sales ? 'SALES' : 'PURCHASES', treatment: t, net: new D(0), vat: new D(0), lines: 0 };
    g.net = g.net.plus(net);
    g.vat = g.vat.plus(vat);
    g.lines++;
    groups.set(key, g);
  }
  const corr = (opts.corrections ?? []).reduce((a, c) => ({ output: a.output.plus(c.output), input: a.input.plus(c.input) }), { output: new D(0), input: new D(0) });
  const due = v.output.plus(corr.output);
  const recoverable = v.input.plus(corr.input);
  const home = AE_EMIRATES.find((e) => e.key === opts.emirate)?.box ?? null;
  const boxes: Record<string, string> = {};
  for (const e of AE_EMIRATES) {
    boxes[e.box] = (e.box === home ? v.standard : new D(0)).toFixed(2);
    boxes[`${e.box}-vat`] = (e.box === home ? v.output : new D(0)).toFixed(2);
  }
  Object.assign(boxes, {
    '4': v.zero.toFixed(2),
    '5': v.exempt.toFixed(2),
    '8': v.standard.plus(v.zero).plus(v.exempt).toFixed(2),
    '8-vat': due.toFixed(2),
    '9': v.expenses.toFixed(2),
    '9-vat': v.input.toFixed(2),
    '11': v.expenses.toFixed(2),
    '11-vat': recoverable.toFixed(2),
    '12': due.toFixed(2),
    '13': recoverable.toFixed(2),
    '14': due.minus(recoverable).abs().toFixed(2),
  });
  const warnings: string[] = [];
  if (untaxed) warnings.push(`${untaxed} ${untaxed === 1 ? 'line has' : 'lines have'} no tax rate and ${untaxed === 1 ? 'is' : 'are'} treated as ${AE_TREATMENT_LABEL[opts.untaxed].toLowerCase()}`);
  if (taxOnNoTax) warnings.push(`${taxOnNoTax} zero-rated, exempt or out-of-scope ${taxOnNoTax === 1 ? 'line carries' : 'lines carry'} VAT, which is left off the return; check the rate on ${taxOnNoTax === 1 ? 'it' : 'them'}`);
  for (const r of rates) {
    if (!used.has(r.id)) continue;
    const t = r.treatment ?? suggestAeTreatment(r.rate, r.name);
    if (t === 'STANDARD' && !new D(r.rate).eq(AE_VAT_RATE)) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as standard-rated, which is 5% in the UAE`);
    if (t && t !== 'STANDARD' && t !== 'REDUCED' && !new D(r.rate).isZero()) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as ${AE_TREATMENT_LABEL[t].toLowerCase()}`);
  }
  const issues = [...unclassified.values()].map((u) => (u.reduced ? `${u.name} is set as reduced-rated, which the UAE does not have: choose another treatment` : `Choose the VAT treatment of ${u.name} (${new D(u.rate).toFixed()}%, ${u.lines} ${u.lines === 1 ? 'line' : 'lines'})`));
  if (!home && !v.standard.isZero()) issues.unshift('Choose the emirate your business is established in, for boxes 1a to 1g');
  const order = (s: string) => (s.startsWith('SALES') ? 0 : 10) + AE_VAT_TREATMENTS.indexOf(s.split(':')[1] as (typeof AE_VAT_TREATMENTS)[number]); // not money: sort key
  return {
    boxes,
    direction: (due.gt(recoverable) ? 'PAY' : due.lt(recoverable) ? 'RECLAIM' : 'NIL') as 'PAY' | 'RECLAIM' | 'NIL',
    own: { output: v.output.toFixed(2), input: v.input.toFixed(2), supplies: v.standard.plus(v.zero).plus(v.exempt).toFixed(2), purchases: v.expenses.toFixed(2) },
    breakdown: [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([, g]) => ({ side: g.side, treatment: g.treatment, label: AE_TREATMENT_LABEL[g.treatment], net: g.net.toFixed(2), vat: g.vat.toFixed(2), lines: g.lines, counted: g.side === 'SALES' ? g.treatment !== 'OUTSIDE_SCOPE' : g.treatment === 'STANDARD' })),
    unclassified: [...unclassified.values()].map(({ reduced: _r, ...u }) => u),
    issues,
    warnings,
  };
}

/** Whether corrections may go on this return: a net tax difference of AED 10,000 or less. Above it, a voluntary disclosure. */
export function aeCorrectionAllowance(corrections: readonly { output: string; input: string }[]) {
  const net = corrections.reduce((a, c) => a.plus(c.output).minus(c.input), new D(0));
  return { net: net.toFixed(2), limit: new D(AE_CORRECTION_LIMIT).toFixed(2), allowed: net.abs().lte(AE_CORRECTION_LIMIT) };
}
