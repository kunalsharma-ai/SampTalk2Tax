import { D, type Dec } from '@talk2tax/accounting-engine';
import { recentVatPeriods, type VatEntry, type VatRateInfo, type VatStagger, type VatTreatment, vatPeriodFor } from '../uk/vat-return';

/**
 * The Canadian GST/HST return (TAX-034), regular method: lines 101 and 103 to 109 of the return a
 * GST/HST registrant files with the Canada Revenue Agency, prepared from the books on the accruals
 * basis, with the business number check, the filing due dates for monthly and quarterly filers
 * and the CRA's rule for claiming input tax credits missed on an earlier return.
 *
 * The same lines as the other returns go in (invoices and credit notes, bills and vendor credits,
 * approved expense claims; voids taken off in the period of the void), with these treatments:
 * taxable (GST at 5%, or HST at 13%, 14% or 15% in the participating provinces), zero-rated,
 * exempt and out of scope.
 *
 *   101 sales and other revenue: revenue from the ledger, GST/HST excluded, in whole dollars
 *       (zero-rated and exempt supplies included);
 *   103 GST/HST collected or collectible; 104 adjustments (0: not modelled); 105 = 103 + 104;
 *   106 input tax credits, with ITCs missed on earlier returns; 107 adjustments (0); 108 = 106 + 107;
 *   109 net tax: 105 less 108, to pay or to be refunded.
 *
 * Not modelled: the Quick Method and other simplified methods, PST and QST, the place-of-supply
 * rules that pick the province's rate, the line 104 and 107 adjustments (bad debts, meals and
 * entertainment, rebates), instalments and rebates (110 to 115), self-assessment (205, 405) and
 * the annual reporting period.
 */

export const CA_GST_TREATMENTS = ['STANDARD', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'] as const satisfies readonly VatTreatment[];
export const CA_TREATMENT_LABEL: Record<VatTreatment, string> = { STANDARD: 'Taxable (GST/HST)', REDUCED: 'Reduced rate', ZERO: 'Zero-rated', EXEMPT: 'Exempt', OUTSIDE_SCOPE: 'Out of scope' };
/** GST 5%; HST 13% (Ontario), 14% (Nova Scotia from 1 April 2025) and 15% (New Brunswick, Newfoundland and Labrador, Prince Edward Island; Nova Scotia before April 2025). */
export const CA_GST_HST_RATES = ['5', '13', '14', '15'] as const;
/** ITCs missed on an earlier return may be claimed for four years (the CRA's general limit). */
export const CA_ITC_MONTHS = 48;

export const CA_RETURN_LABEL = {
  '101': 'Sales and other revenue',
  '103': 'GST/HST collected or collectible',
  '104': 'Adjustments',
  '105': 'Total GST/HST and adjustments for the period (103 plus 104)',
  '106': 'Input tax credits (ITCs) for the current period',
  '107': 'Adjustments',
  '108': 'Total ITCs and adjustments (106 plus 107)',
  '109': 'Net tax (105 minus 108)',
} as const;

/**
 * A business number with the GST/HST program account: 9 digits passing the Luhn check, then RT
 * and a 4-digit reference (RT0001 for most). Spaces and dashes allowed. Returns 123456782RT0001 or null.
 */
export function normaliseCaBusinessNumber(input: string): string | null {
  const s = input.replace(/[\s-]/g, '').toUpperCase();
  if (!/^\d{9}RT\d{4}$/.test(s)) return null;
  let sum = 0; // not money: check digits
  for (let i = 0; i < 9; i++) {
    let d = Number(s[8 - i]); // not money
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2; // not money
    sum += d;
  }
  return sum % 10 === 0 ? s : null; // not money
}

export function suggestCaTreatment(rate: string, name: string): VatTreatment | null {
  const r = new D(rate);
  const n = name.toLowerCase();
  if (CA_GST_HST_RATES.some((x) => r.eq(x))) return 'STANDARD';
  if (!r.isZero()) return null;
  if (n.includes('exempt')) return 'EXEMPT';
  if (n.includes('out of scope') || n.includes('outside') || n.includes('no gst')) return 'OUTSIDE_SCOPE';
  return 'ZERO';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Monthly and quarterly filers: the return and payment are due one month after the reporting period ends. */
export function caGstHstDueDate(end: string) {
  const t = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)); // not money: next month, 0-based count
  const y = Math.floor(t / 12); // not money
  const m = (t % 12) + 1; // not money
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

export function caGstHstPeriodFor(stagger: VatStagger, end: string) {
  const p = vatPeriodFor(stagger, end);
  return p ? { ...p, due: caGstHstDueDate(end) } : null;
}

export function recentCaGstHstPeriods(stagger: VatStagger, today: string, count: number) {
  return recentVatPeriods(stagger, today, count).map((p) => ({ ...p, due: caGstHstDueDate(p.end) }));
}

const SALES = new Set(['INVOICE', 'CREDIT_NOTE']);
const NEGATIVE = new Set(['CREDIT_NOTE', 'VENDOR_CREDIT']);

/** The return's lines for a period. Revenue is the ledger's (line 101). Corrections are ITCs missed on earlier returns, claimed at line 106. */
export function caGstHstReturn(entries: readonly VatEntry[], rates: readonly VatRateInfo[], opts: { untaxed: VatTreatment; revenue: string; corrections?: readonly { output: string; input: string }[] }) {
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
    } else t = rate ? (rate.treatment ?? suggestCaTreatment(rate.rate, rate.name)) : null;
    if (!t || t === 'REDUCED') {
      const u = unclassified.get(e.taxRateId!) ?? { id: e.taxRateId!, name: rate?.name ?? 'A deleted tax rate', rate: rate?.rate ?? e.rate, lines: 0, reduced: t === 'REDUCED' };
      u.lines++;
      unclassified.set(e.taxRateId!, u);
      continue;
    }
    const sign = (NEGATIVE.has(e.source) ? -1 : 1) * (e.reversal ? -1 : 1); // not money: a direction
    const net = new D(e.net).times(sign);
    const tax = new D(e.vat).times(sign);
    const sales = SALES.has(e.source);
    if (t !== 'STANDARD' && !tax.isZero()) taxOnNoTax++;
    if (sales && t !== 'OUTSIDE_SCOPE') {
      v.sales = v.sales.plus(net);
      if (t === 'STANDARD') v.output = v.output.plus(tax);
    } else if (!sales && t === 'STANDARD') {
      v.purchases = v.purchases.plus(net);
      v.input = v.input.plus(tax);
    }
    const key = `${sales ? 'SALES' : 'PURCHASES'}:${t}`;
    const g = groups.get(key) ?? { side: sales ? 'SALES' : 'PURCHASES', treatment: t, net: new D(0), vat: new D(0), lines: 0 };
    g.net = g.net.plus(net);
    g.vat = g.vat.plus(tax);
    g.lines++;
    groups.set(key, g);
  }
  const corr = (opts.corrections ?? []).reduce((a, c) => ({ output: a.output.plus(c.output), input: a.input.plus(c.input) }), { output: new D(0), input: new D(0) });
  const l103 = v.output.plus(corr.output);
  const l106 = v.input.plus(corr.input);
  const l105 = l103;
  const l108 = l106;
  const boxes: Record<string, string> = {
    '101': new D(opts.revenue).toFixed(0, 4), // to the nearest dollar, halves up
    '103': l103.toFixed(2),
    '104': '0.00',
    '105': l105.toFixed(2),
    '106': l106.toFixed(2),
    '107': '0.00',
    '108': l108.toFixed(2),
    '109': l105.minus(l108).abs().toFixed(2),
  };
  const warnings: string[] = [];
  if (untaxed) warnings.push(`${untaxed} ${untaxed === 1 ? 'line has' : 'lines have'} no tax rate and ${untaxed === 1 ? 'is' : 'are'} treated as ${CA_TREATMENT_LABEL[opts.untaxed].toLowerCase()}`);
  if (taxOnNoTax) warnings.push(`${taxOnNoTax} zero-rated, exempt or out-of-scope ${taxOnNoTax === 1 ? 'line carries' : 'lines carry'} GST/HST, which is left off the return; check the rate on ${taxOnNoTax === 1 ? 'it' : 'them'}`);
  for (const r of rates) {
    if (!used.has(r.id)) continue;
    const t = r.treatment ?? suggestCaTreatment(r.rate, r.name);
    if (t === 'STANDARD' && !CA_GST_HST_RATES.some((x) => new D(r.rate).eq(x))) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as taxable: GST is 5% and HST 13%, 14% or 15%; PST and QST are not on this return`);
    if (t && t !== 'STANDARD' && t !== 'REDUCED' && !new D(r.rate).isZero()) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as ${CA_TREATMENT_LABEL[t].toLowerCase()}`);
  }
  const issues = [...unclassified.values()].map((u) => (u.reduced ? `${u.name} is set as reduced-rated, which Canada does not have: choose another treatment` : `Choose the GST/HST treatment of ${u.name} (${new D(u.rate).toFixed()}%, ${u.lines} ${u.lines === 1 ? 'line' : 'lines'})`));
  const order = (s: string) => (s.startsWith('SALES') ? 0 : 10) + CA_GST_TREATMENTS.indexOf(s.split(':')[1] as (typeof CA_GST_TREATMENTS)[number]); // not money: sort key
  return {
    boxes,
    direction: (l105.gt(l108) ? 'PAY' : l105.lt(l108) ? 'RECLAIM' : 'NIL') as 'PAY' | 'RECLAIM' | 'NIL',
    own: { output: v.output.toFixed(2), input: v.input.toFixed(2), supplies: v.sales.toFixed(2), purchases: v.purchases.toFixed(2) },
    breakdown: [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([, g]) => ({ side: g.side, treatment: g.treatment, label: CA_TREATMENT_LABEL[g.treatment], net: g.net.toFixed(2), vat: g.vat.toFixed(2), lines: g.lines, counted: g.side === 'SALES' ? g.treatment !== 'OUTSIDE_SCOPE' : g.treatment === 'STANDARD' })),
    unclassified: [...unclassified.values()].map(({ reduced: _r, ...u }) => u),
    issues,
    warnings,
  };
}

/**
 * Whether changes to earlier returns may go on this one. The CRA lets ITCs missed on an earlier
 * return be claimed on a later one (line 106, within four years); GST/HST under- or over-reported,
 * or ITCs over-claimed, are corrected by asking the CRA to adjust the earlier return.
 */
export function caCorrectionAllowance(corrections: readonly { output: string; input: string }[]) {
  const net = corrections.reduce((a, c) => a.plus(c.output).minus(c.input), new D(0));
  const allowed = corrections.every((c) => new D(c.output).isZero() && !new D(c.input).isNegative());
  return { net: net.toFixed(2), limit: '0.00', allowed };
}
