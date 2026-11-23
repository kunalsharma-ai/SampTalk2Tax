import { D, type Dec } from '@talk2tax/accounting-engine';
import { recentVatPeriods, type VatEntry, type VatRateInfo, type VatStagger, type VatTreatment, vatPeriodFor } from '../uk/vat-return';

/**
 * Australian GST on the business activity statement (TAX-035): the Simpler BAS GST items the ATO
 * asks small businesses for (turnover under A$10 million), prepared from the books on the accruals
 * (non-cash) basis, with the ABN check, the BAS due dates and the ATO's limit for correcting a
 * GST error on a later BAS.
 *
 * The same lines as the other returns go in (invoices and credit notes, bills and vendor credits,
 * approved expense claims; voids taken off in the period of the void), with these treatments:
 * taxable (10%), GST-free, input-taxed and out of scope.
 *
 *   G1 total sales, including GST: taxable, GST-free and input-taxed sales;
 *   1A GST on sales; 1B GST on purchases (creditable acquisitions: taxable purchases only);
 *   net: 1A less 1B, to pay or to be refunded.
 *
 * The BAS is reported in whole dollars, cents left off. Not modelled: the full GST reporting
 * items (G2 to G20), the cash basis, PAYG withholding and instalments, fuel tax credits, wine
 * equalisation and luxury car tax, GST on imports deferred to the BAS, and claims of input tax
 * credits that need a tax invoice the business may not hold.
 */

export const AU_GST_TREATMENTS = ['STANDARD', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'] as const satisfies readonly VatTreatment[];
export const AU_TREATMENT_LABEL: Record<VatTreatment, string> = { STANDARD: 'Taxable (10%)', REDUCED: 'Reduced rate', ZERO: 'GST-free', EXEMPT: 'Input-taxed', OUTSIDE_SCOPE: 'Out of scope' };
export const AU_GST_RATE = '10';
/** ATO: a business with turnover under A$20 million may correct GST errors of up to A$10,000 on a later BAS (within 18 months). */
export const AU_CORRECTION_LIMIT = '10000';
export const AU_STAGGERS = ['MONTHLY', 'QUARTERLY_MAR'] as const satisfies readonly VatStagger[];

export const AU_BAS_LABEL = {
  G1: 'Total sales (including any GST)',
  '1A': 'GST on sales',
  '1B': 'GST on purchases',
  net: 'Net GST for the period (1A less 1B)',
} as const;

/**
 * An Australian Business Number: 11 digits, spaces allowed, passing the ATO's check (take 1 from
 * the first digit, weight the digits 10, 1, 3, 5, ..., 19, and the sum divides by 89). Returns the
 * 11 digits or null.
 */
export function normaliseAbn(input: string): string | null {
  const s = input.replace(/\s/g, '');
  if (!/^\d{11}$/.test(s)) return null;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const total = s.split('').reduce((a, ch, i) => a + (Number(ch) - (i === 0 ? 1 : 0)) * w[i]!, 0); // not money: check digits
  return total % 89 === 0 ? s : null; // not money
}

export function suggestAuTreatment(rate: string, name: string): VatTreatment | null {
  const r = new D(rate);
  const n = name.toLowerCase();
  if (r.eq(AU_GST_RATE)) return 'STANDARD';
  if (!r.isZero()) return null;
  if (n.includes('input taxed') || n.includes('input-taxed')) return 'EXEMPT';
  if (n.includes('out of scope') || n.includes('outside') || n.includes('no gst')) return 'OUTSIDE_SCOPE';
  return 'ZERO';
}

const pad = (n: number) => String(n).padStart(2, '0');
/**
 * BAS due dates: a monthly BAS on the 21st of the next month; a quarterly BAS on the 28th of the
 * month after the quarter, except October to December, due 28 February. (Lodging through a
 * registered agent can give later dates; not modelled.)
 */
export function auBasDueDate(end: string, monthly: boolean) {
  const y = Number(end.slice(0, 4)); // not money
  const m = Number(end.slice(5, 7)); // not money
  const t = y * 12 + m + (!monthly && m === 12 ? 1 : 0); // not money: the month after (two after December)
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}-${monthly ? '21' : '28'}`;
}

export function auBasPeriodFor(stagger: VatStagger, end: string) {
  if (!(AU_STAGGERS as readonly string[]).includes(stagger)) return null;
  const p = vatPeriodFor(stagger, end);
  return p ? { ...p, due: auBasDueDate(end, stagger === 'MONTHLY') } : null;
}

export function recentAuBasPeriods(stagger: VatStagger, today: string, count: number) {
  return recentVatPeriods(stagger, today, count).map((p) => ({ ...p, due: auBasDueDate(p.end, stagger === 'MONTHLY') }));
}

const SALES = new Set(['INVOICE', 'CREDIT_NOTE']);
const NEGATIVE = new Set(['CREDIT_NOTE', 'VENDOR_CREDIT']);
const dollars = (x: Dec) => x.toFixed(0, 1); // whole dollars, cents left off (toward zero)

/** The BAS GST items for a period. Corrections are GST on sales (output) and on purchases (input) of earlier periods. */
export function auGstBas(entries: readonly VatEntry[], rates: readonly VatRateInfo[], opts: { untaxed: VatTreatment; corrections?: readonly { output: string; input: string }[] }) {
  const byId = new Map(rates.map((r) => [r.id, r]));
  const v = { sales: new D(0), output: new D(0), input: new D(0), purchases: new D(0) };
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
    } else t = rate ? (rate.treatment ?? suggestAuTreatment(rate.rate, rate.name)) : null;
    if (!t || t === 'REDUCED') {
      const u = unclassified.get(e.taxRateId!) ?? { id: e.taxRateId!, name: rate?.name ?? 'A deleted tax rate', rate: rate?.rate ?? e.rate, lines: 0, reduced: t === 'REDUCED' };
      u.lines++;
      unclassified.set(e.taxRateId!, u);
      continue;
    }
    const sign = (NEGATIVE.has(e.source) ? -1 : 1) * (e.reversal ? -1 : 1); // not money: a direction
    const net = new D(e.net).times(sign);
    const gst = new D(e.vat).times(sign);
    const sales = SALES.has(e.source);
    if (t !== 'STANDARD' && !gst.isZero()) taxOnNoTax++;
    if (sales && t !== 'OUTSIDE_SCOPE') {
      // G1 is GST-inclusive.
      v.sales = v.sales.plus(net).plus(t === 'STANDARD' ? gst : 0);
      if (t === 'STANDARD') v.output = v.output.plus(gst);
    } else if (!sales && t !== 'OUTSIDE_SCOPE') {
      v.purchases = v.purchases.plus(net).plus(t === 'STANDARD' ? gst : 0);
      if (t === 'STANDARD') v.input = v.input.plus(gst);
    }
    const key = `${sales ? 'SALES' : 'PURCHASES'}:${t}`;
    const g = groups.get(key) ?? { side: sales ? 'SALES' : 'PURCHASES', treatment: t, net: new D(0), vat: new D(0), lines: 0 };
    g.net = g.net.plus(net);
    g.vat = g.vat.plus(gst);
    g.lines++;
    groups.set(key, g);
  }
  const corr = (opts.corrections ?? []).reduce((a, c) => ({ output: a.output.plus(c.output), input: a.input.plus(c.input) }), { output: new D(0), input: new D(0) });
  const a1 = new D(dollars(v.output.plus(corr.output)));
  const b1 = new D(dollars(v.input.plus(corr.input)));
  const boxes = { G1: dollars(v.sales), '1A': a1.toFixed(0), '1B': b1.toFixed(0), net: a1.minus(b1).abs().toFixed(0) };
  const warnings: string[] = [];
  if (untaxed) warnings.push(`${untaxed} ${untaxed === 1 ? 'line has' : 'lines have'} no tax rate and ${untaxed === 1 ? 'is' : 'are'} treated as ${AU_TREATMENT_LABEL[opts.untaxed].toLowerCase()}`);
  if (taxOnNoTax) warnings.push(`${taxOnNoTax} GST-free, input-taxed or out-of-scope ${taxOnNoTax === 1 ? 'line carries' : 'lines carry'} GST, which is left off the BAS; check the rate on ${taxOnNoTax === 1 ? 'it' : 'them'}`);
  for (const r of rates) {
    if (!used.has(r.id)) continue;
    const t = r.treatment ?? suggestAuTreatment(r.rate, r.name);
    if (t === 'STANDARD' && !new D(r.rate).eq(AU_GST_RATE)) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as taxable, which is 10% in Australia`);
    if (t && t !== 'STANDARD' && t !== 'REDUCED' && !new D(r.rate).isZero()) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as ${AU_TREATMENT_LABEL[t].toLowerCase()}`);
  }
  const issues = [...unclassified.values()].map((u) => (u.reduced ? `${u.name} is set as reduced-rated, which Australia does not have: choose another treatment` : `Choose the GST treatment of ${u.name} (${new D(u.rate).toFixed()}%, ${u.lines} ${u.lines === 1 ? 'line' : 'lines'})`));
  const order = (s: string) => (s.startsWith('SALES') ? 0 : 10) + AU_GST_TREATMENTS.indexOf(s.split(':')[1] as (typeof AU_GST_TREATMENTS)[number]); // not money: sort key
  return {
    boxes,
    direction: (a1.gt(b1) ? 'PAY' : a1.lt(b1) ? 'RECLAIM' : 'NIL') as 'PAY' | 'RECLAIM' | 'NIL',
    own: { output: v.output.toFixed(2), input: v.input.toFixed(2), supplies: v.sales.toFixed(2), purchases: v.purchases.toFixed(2) },
    breakdown: [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([, g]) => ({ side: g.side, treatment: g.treatment, label: AU_TREATMENT_LABEL[g.treatment], net: g.net.toFixed(2), vat: g.vat.toFixed(2), lines: g.lines, counted: g.treatment !== 'OUTSIDE_SCOPE' })),
    unclassified: [...unclassified.values()].map(({ reduced: _r, ...u }) => u),
    issues,
    warnings,
  };
}

/** Whether corrections may go on this BAS: GST errors of A$10,000 or less (turnover under A$20 million). Above it, revise the earlier BAS. */
export function auCorrectionAllowance(corrections: readonly { output: string; input: string }[]) {
  const net = corrections.reduce((a, c) => a.plus(c.output).minus(c.input), new D(0));
  return { net: net.toFixed(2), limit: new D(AU_CORRECTION_LIMIT).toFixed(2), allowed: net.abs().lte(AU_CORRECTION_LIMIT) };
}
