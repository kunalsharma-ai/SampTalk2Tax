import { D, type Dec } from '@talk2tax/accounting-engine';
import { recentVatPeriods, type VatEntry, type VatRateInfo, type VatStagger, type VatTreatment, VAT_TREATMENT_LABEL, vatPeriodFor } from '../uk/vat-return';

/**
 * Singapore GST F5 return (TAX-036): the boxes IRAS asks for each accounting period, prepared from
 * the books, for a GST-registered business, with the GST registration number format check, the
 * due date (one month after the period ends) and IRAS's limit for correcting an earlier return on
 * the next one.
 *
 * The same lines as the UK return go in (invoices and credit notes, bills and vendor credits,
 * approved expense claims; voids taken off in the period of the void), with these treatments:
 * standard-rated, zero-rated, exempt and out of scope (Singapore has no reduced rate).
 *
 *   1 standard-rated supplies; 2 zero-rated supplies; 3 exempt supplies; 4 = 1 + 2 + 3;
 *   5 taxable purchases (standard-rated and zero-rated, excluding GST); 6 output tax due;
 *   7 input tax and refunds claimed; 8 = 6 - 7, net GST to pay (or to claim when negative, shown
 *   as a positive amount with the direction); 13 revenue for the period (from the ledger).
 *
 * Boxes 9 to 12 and 14 onwards (imports under schemes, tourist refunds, bad debt relief,
 * pre-registration claims, reverse charge, electronic marketplaces) are not modelled and stay 0.
 * Input tax is claimed on every standard-rated purchase line: blocked input tax (club
 * subscriptions, medical expenses, private cars and the like, GST Regulations 26 and 27) and the
 * partial exemption rules are not applied.
 */

export const SG_GST_TREATMENTS = ['STANDARD', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'] as const satisfies readonly VatTreatment[];
/** Standard rates in force since 2007: 7%, 8% from 1 January 2023 and 9% from 1 January 2024 (IRAS). */
export const SG_STANDARD_RATES = ['7', '8', '9'] as const;
/** IRAS: an error whose net GST is S$1,500 or less may be corrected on the next return; above that, file GST F7. */
export const SG_CORRECTION_LIMIT = '1500';

export const SG_F5_BOX_LABEL = {
  box1: 'Total value of standard-rated supplies',
  box2: 'Total value of zero-rated supplies',
  box3: 'Total value of exempt supplies',
  box4: 'Total value of (1) + (2) + (3)',
  box5: 'Total value of taxable purchases',
  box6: 'Output tax due',
  box7: 'Input tax and refunds claimed',
  box8: 'Net GST to be paid to or claimed from IRAS',
  box13: 'Revenue for the accounting period',
} as const;
export type SgF5Boxes = Record<keyof typeof SG_F5_BOX_LABEL, string>;

/**
 * A Singapore GST registration number: the business's UEN (8 digits and a letter for businesses,
 * 9 digits and a letter for local companies, or the T/S/R/F form) or an M-number (M2 or MR and
 * digits, as IRAS issues to others). Only the format is checked: IRAS's check-letter rules are not
 * published. Returns it in capitals without spaces or hyphens, or null.
 */
export function normaliseSgGstNumber(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  return /^(\d{8}[A-Z]|\d{9}[A-Z]|[STRF]\d{2}[A-Z]{2}\d{4}[A-Z]|M[0-9R]\d{7}[0-9A-Z])$/.test(s) ? s : null;
}

export function suggestSgTreatment(rate: string, name: string): VatTreatment | null {
  const r = new D(rate);
  const n = name.toLowerCase();
  if (SG_STANDARD_RATES.some((x) => r.eq(x))) return 'STANDARD';
  if (!r.isZero()) return null;
  if (n.includes('exempt')) return 'EXEMPT';
  if (n.includes('out of scope') || n.includes('out-of-scope') || n.includes('outside') || n.includes('no gst')) return 'OUTSIDE_SCOPE';
  return 'ZERO';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The return is due one month after the end of the period: the last day of the next month. */
export function sgGstDueDate(end: string) {
  const t = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)); // not money: next month, 0-based count
  const y = Math.floor(t / 12); // not money
  const m = (t % 12) + 1; // not money
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

export function sgGstPeriodFor(stagger: VatStagger, end: string) {
  const p = vatPeriodFor(stagger, end);
  return p ? { ...p, due: sgGstDueDate(end) } : null;
}

export function recentSgGstPeriods(stagger: VatStagger, today: string, count: number) {
  return recentVatPeriods(stagger, today, count).map((p) => ({ ...p, due: sgGstDueDate(p.end) }));
}

const SALES = new Set(['INVOICE', 'CREDIT_NOTE']);
const NEGATIVE = new Set(['CREDIT_NOTE', 'VENDOR_CREDIT']);

/** The F5 for a period. `revenue` is box 13 from the ledger; corrections are output and input tax of earlier periods. */
export function sgGstReturn(entries: readonly VatEntry[], rates: readonly VatRateInfo[], opts: { untaxed: VatTreatment; revenue: string; corrections?: readonly { output: string; input: string }[] }) {
  const byId = new Map(rates.map((r) => [r.id, r]));
  const v = { std: new D(0), zero: new D(0), exempt: new D(0), purchases: new D(0), output: new D(0), input: new D(0) };
  const groups = new Map<string, { side: 'SALES' | 'PURCHASES'; treatment: VatTreatment; net: Dec; vat: Dec; lines: number }>();
  const unclassified = new Map<string, { id: string; name: string; rate: string; lines: number; reduced: boolean }>();
  const used = new Set<string>();
  let untaxedLines = 0; // not money: count
  let taxOnNoTax = 0; // not money: count
  for (const e of entries) {
    const rate = e.taxRateId ? byId.get(e.taxRateId) : undefined;
    if (e.taxRateId) used.add(e.taxRateId);
    let t: VatTreatment | null;
    if (!e.taxRateId) {
      t = opts.untaxed;
      untaxedLines++;
    } else t = rate ? (rate.treatment ?? suggestSgTreatment(rate.rate, rate.name)) : null;
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
    if ((t === 'EXEMPT' || t === 'OUTSIDE_SCOPE') && !vat.isZero()) taxOnNoTax++;
    if (sales) {
      if (t === 'STANDARD') [v.std, v.output] = [v.std.plus(net), v.output.plus(vat)];
      else if (t === 'ZERO') v.zero = v.zero.plus(net);
      else if (t === 'EXEMPT') v.exempt = v.exempt.plus(net);
    } else if (t === 'STANDARD' || t === 'ZERO') {
      v.purchases = v.purchases.plus(net);
      if (t === 'STANDARD') v.input = v.input.plus(vat);
    }
    const key = `${sales ? 'SALES' : 'PURCHASES'}:${t}`;
    const g = groups.get(key) ?? { side: sales ? 'SALES' : 'PURCHASES', treatment: t, net: new D(0), vat: new D(0), lines: 0 };
    g.net = g.net.plus(net);
    g.vat = g.vat.plus(vat);
    g.lines++;
    groups.set(key, g);
  }
  const corr = (opts.corrections ?? []).reduce((a, c) => ({ output: a.output.plus(c.output), input: a.input.plus(c.input) }), { output: new D(0), input: new D(0) });
  const out6 = v.output.plus(corr.output);
  const in7 = v.input.plus(corr.input);
  const boxes: SgF5Boxes = {
    box1: v.std.toFixed(2),
    box2: v.zero.toFixed(2),
    box3: v.exempt.toFixed(2),
    box4: v.std.plus(v.zero).plus(v.exempt).toFixed(2),
    box5: v.purchases.toFixed(2),
    box6: out6.toFixed(2),
    box7: in7.toFixed(2),
    box8: out6.minus(in7).abs().toFixed(2),
    box13: new D(opts.revenue).toFixed(2),
  };
  const warnings: string[] = [];
  if (untaxedLines) warnings.push(`${untaxedLines} ${untaxedLines === 1 ? 'line has' : 'lines have'} no tax rate and ${untaxedLines === 1 ? 'is' : 'are'} treated as ${VAT_TREATMENT_LABEL[opts.untaxed].charAt(0).toLowerCase()}${VAT_TREATMENT_LABEL[opts.untaxed].slice(1)}`);
  if (taxOnNoTax) warnings.push(`${taxOnNoTax} exempt or out-of-scope ${taxOnNoTax === 1 ? 'line carries' : 'lines carry'} GST, which is left off the return; check the rate on ${taxOnNoTax === 1 ? 'it' : 'them'}`);
  for (const r of rates) {
    if (!used.has(r.id)) continue;
    const t = r.treatment ?? suggestSgTreatment(r.rate, r.name);
    if (t === 'STANDARD' && !SG_STANDARD_RATES.some((x) => new D(r.rate).eq(x))) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as standard-rated, which is 9% in Singapore (8% in 2023, 7% before)`);
    if (t === 'ZERO' && !new D(r.rate).isZero()) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as zero-rated`);
  }
  const issues = [...unclassified.values()].map((u) => (u.reduced ? `${u.name} is set as reduced-rated, which Singapore does not have: choose another treatment` : `Choose the GST treatment of ${u.name} (${new D(u.rate).toFixed()}%, ${u.lines} ${u.lines === 1 ? 'line' : 'lines'})`));
  const order = (s: string) => (s.startsWith('SALES') ? 0 : 10) + SG_GST_TREATMENTS.indexOf(s.split(':')[1] as (typeof SG_GST_TREATMENTS)[number]); // not money: sort key
  return {
    boxes,
    direction: (out6.gt(in7) ? 'PAY' : out6.lt(in7) ? 'RECLAIM' : 'NIL') as 'PAY' | 'RECLAIM' | 'NIL',
    own: { output: v.output.toFixed(2), input: v.input.toFixed(2), supplies: v.std.plus(v.zero).plus(v.exempt).toFixed(2), purchases: v.purchases.toFixed(2) },
    corrections: { output: corr.output.toFixed(2), input: corr.input.toFixed(2) },
    breakdown: [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([, g]) => ({ side: g.side, treatment: g.treatment, label: SG_TREATMENT_LABEL[g.treatment], net: g.net.toFixed(2), vat: g.vat.toFixed(2), lines: g.lines, counted: g.treatment !== 'OUTSIDE_SCOPE' && !(g.side === 'PURCHASES' && g.treatment === 'EXEMPT') })),
    unclassified: [...unclassified.values()].map(({ reduced: _r, ...u }) => u),
    issues,
    warnings,
  };
}

export const SG_TREATMENT_LABEL: Record<VatTreatment, string> = { STANDARD: 'Standard-rated', REDUCED: 'Reduced rate', ZERO: 'Zero-rated', EXEMPT: 'Exempt', OUTSIDE_SCOPE: 'Out of scope' };

/** Whether corrections of earlier returns may go on this one: net GST of S$1,500 or less. Above it, file GST F7. */
export function sgCorrectionAllowance(corrections: readonly { output: string; input: string }[]) {
  const net = corrections.reduce((a, c) => a.plus(c.output).minus(c.input), new D(0));
  return { net: net.toFixed(2), limit: new D(SG_CORRECTION_LIMIT).toFixed(2), allowed: net.abs().lte(SG_CORRECTION_LIMIT) };
}
