import { D, type Dec } from '@talk2tax/accounting-engine';
import { recentVatPeriods, type VatEntry, type VatRateInfo, type VatStagger, type VatTreatment, vatPeriodFor } from '../uk/vat-return';

/**
 * Germany's VAT advance return, the Umsatzsteuer-Voranmeldung (TAX-031, EU VAT starting with
 * Germany), prepared from the books on the accruals basis (Soll-Versteuerung), with the USt-IdNr.
 * check, the due date and the rule that an error is corrected on a corrected return for its own
 * period (berichtigte Voranmeldung), not on a later one.
 *
 * The same lines as the other returns go in (invoices and credit notes, bills and vendor credits,
 * approved expense claims; voids taken off in the period of the void), with these treatments:
 * standard (19%), reduced (7%), tax-free with input tax deduction (zero), tax-free without it
 * (exempt) and not taxable (out of scope).
 *
 *   Kz 81 taxable supplies at 19% and Kz 86 at 7%: net, in whole euros, with the tax the form
 *         works out from them (19% and 7% of the base);
 *   Kz 43 other tax-free supplies with input tax deduction (exports); Kz 48 tax-free supplies
 *         without it; both in whole euros;
 *   Kz 66 input tax on invoices from other businesses;
 *   Kz 83 the advance payment due (or the surplus): the tax on 81 and 86 less 66.
 *
 * Not modelled: intra-EU supplies (Kz 41) and acquisitions (Kz 89, 61), the reverse charge
 * (§ 13b, Kz 46 to 67), the small-business rule (§ 19), cash accounting (Ist-Versteuerung), the
 * permanent extension (Dauerfristverlängerung) and its special payment, and the annual return.
 */

export const DE_VAT_TREATMENTS = ['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'] as const satisfies readonly VatTreatment[];
export const DE_TREATMENT_LABEL: Record<VatTreatment, string> = {
  STANDARD: 'Standard (19%)',
  REDUCED: 'Reduced (7%)',
  ZERO: 'Tax-free with input tax deduction',
  EXEMPT: 'Tax-free without input tax deduction',
  OUTSIDE_SCOPE: 'Not taxable',
};
export const DE_VAT_RATE: Partial<Record<VatTreatment, string>> = { STANDARD: '19', REDUCED: '7' };

export const DE_USTVA_LABEL: Record<string, string> = {
  '81': 'Taxable supplies at 19% (Umsätze zu 19 %): base',
  '81-vat': 'Tax on Kz 81',
  '86': 'Taxable supplies at 7% (Umsätze zu 7 %): base',
  '86-vat': 'Tax on Kz 86',
  '43': 'Other tax-free supplies with input tax deduction, such as exports',
  '48': 'Tax-free supplies without input tax deduction',
  '66': 'Input tax on invoices from other businesses (Vorsteuer)',
  '83': 'Advance payment due or surplus (Vorauszahlung / Überschuss)',
};
export const DE_USTVA_ORDER: readonly string[] = ['81', '81-vat', '86', '86-vat', '43', '48', '66', '83'];

/**
 * A German VAT identification number (USt-IdNr.): DE and 9 digits, the last a check digit
 * (ISO 7064 MOD 11,10). Spaces allowed. Returns DE123456788 or null.
 */
export function normaliseUstIdNr(input: string): string | null {
  const s = input.replace(/\s/g, '').toUpperCase();
  if (!/^DE\d{9}$/.test(s)) return null;
  let p = 10; // not money: check digit
  for (let i = 2; i < 10; i++) {
    let x = (Number(s[i]) + p) % 10; // not money
    if (x === 0) x = 10;
    p = (2 * x) % 11; // not money
  }
  const check = 11 - p === 10 ? 0 : 11 - p; // not money
  return check === Number(s[10]) ? s : null;
}

export function suggestDeTreatment(rate: string, name: string): VatTreatment | null {
  const r = new D(rate);
  const n = name.toLowerCase();
  if (r.eq(DE_VAT_RATE.STANDARD!)) return 'STANDARD';
  if (r.eq(DE_VAT_RATE.REDUCED!)) return 'REDUCED';
  if (!r.isZero()) return null;
  if (n.includes('exempt') || n.includes('ohne vorsteuer') || n.includes('§ 4 nr. 8') || n.includes('§ 4 nr. 12')) return 'EXEMPT';
  if (n.includes('not taxable') || n.includes('nicht steuerbar') || n.includes('out of scope')) return 'OUTSIDE_SCOPE';
  return 'ZERO';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Due on the 10th day after the period ends (without the permanent extension). */
export function deUstvaDueDate(end: string) {
  const t = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)); // not money: next month, 0-based count
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}-10`;
}

export const DE_STAGGERS = ['MONTHLY', 'QUARTERLY_MAR'] as const satisfies readonly VatStagger[];

export function deUstvaPeriodFor(stagger: VatStagger, end: string) {
  if (!(DE_STAGGERS as readonly string[]).includes(stagger)) return null;
  const p = vatPeriodFor(stagger, end);
  return p ? { ...p, due: deUstvaDueDate(end) } : null;
}

export function recentDeUstvaPeriods(stagger: VatStagger, today: string, count: number) {
  return recentVatPeriods(stagger, today, count).map((p) => ({ ...p, due: deUstvaDueDate(p.end) }));
}

const SALES = new Set(['INVOICE', 'CREDIT_NOTE']);
const NEGATIVE = new Set(['CREDIT_NOTE', 'VENDOR_CREDIT']);
const euros = (x: Dec) => x.toFixed(0, 1); // whole euros, cents left off (toward zero)

/** The Kennzahlen for a period. The tax on Kz 81 and 86 is worked out from the whole-euro bases, as the form does. */
export function deUstVoranmeldung(entries: readonly VatEntry[], rates: readonly VatRateInfo[], opts: { untaxed: VatTreatment }) {
  const byId = new Map(rates.map((r) => [r.id, r]));
  const v = { s19: new D(0), s7: new D(0), tax19: new D(0), tax7: new D(0), zero: new D(0), exempt: new D(0), input: new D(0), purchases: new D(0) };
  const groups = new Map<string, { side: 'SALES' | 'PURCHASES'; treatment: VatTreatment; net: Dec; vat: Dec; lines: number }>();
  const unclassified = new Map<string, { id: string; name: string; rate: string; lines: number }>();
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
    } else t = rate ? (rate.treatment ?? suggestDeTreatment(rate.rate, rate.name)) : null;
    if (!t) {
      const u = unclassified.get(e.taxRateId!) ?? { id: e.taxRateId!, name: rate?.name ?? 'A deleted tax rate', rate: rate?.rate ?? e.rate, lines: 0 };
      u.lines++;
      unclassified.set(e.taxRateId!, u);
      continue;
    }
    const sign = (NEGATIVE.has(e.source) ? -1 : 1) * (e.reversal ? -1 : 1); // not money: a direction
    const net = new D(e.net).times(sign);
    const vat = new D(e.vat).times(sign);
    const sales = SALES.has(e.source);
    const taxed = t === 'STANDARD' || t === 'REDUCED';
    if (!taxed && !vat.isZero()) taxOnNoTax++;
    if (sales) {
      if (t === 'STANDARD') [v.s19, v.tax19] = [v.s19.plus(net), v.tax19.plus(vat)];
      else if (t === 'REDUCED') [v.s7, v.tax7] = [v.s7.plus(net), v.tax7.plus(vat)];
      else if (t === 'ZERO') v.zero = v.zero.plus(net);
      else if (t === 'EXEMPT') v.exempt = v.exempt.plus(net);
    } else if (taxed) {
      v.input = v.input.plus(vat);
      v.purchases = v.purchases.plus(net);
    }
    const key = `${sales ? 'SALES' : 'PURCHASES'}:${t}`;
    const g = groups.get(key) ?? { side: sales ? 'SALES' : 'PURCHASES', treatment: t, net: new D(0), vat: new D(0), lines: 0 };
    g.net = g.net.plus(net);
    g.vat = g.vat.plus(vat);
    g.lines++;
    groups.set(key, g);
  }
  const b81 = new D(euros(v.s19));
  const b86 = new D(euros(v.s7));
  const t81 = b81.times('0.19').toDecimalPlaces(2, 4);
  const t86 = b86.times('0.07').toDecimalPlaces(2, 4);
  const output = t81.plus(t86);
  const boxes: Record<string, string> = {
    '81': b81.toFixed(0),
    '81-vat': t81.toFixed(2),
    '86': b86.toFixed(0),
    '86-vat': t86.toFixed(2),
    '43': euros(v.zero),
    '48': euros(v.exempt),
    '66': v.input.toFixed(2),
    '83': output.minus(v.input).abs().toFixed(2),
    /** Not a Kennzahl: the tax on 81 and 86 together, kept so a filed return shows whether it was a payment or a surplus. */
    output: output.toFixed(2),
  };
  const warnings: string[] = [];
  if (untaxed) warnings.push(`${untaxed} ${untaxed === 1 ? 'line has' : 'lines have'} no tax rate and ${untaxed === 1 ? 'is' : 'are'} treated as ${DE_TREATMENT_LABEL[opts.untaxed].toLowerCase()}`);
  if (taxOnNoTax) warnings.push(`${taxOnNoTax} tax-free or not-taxable ${taxOnNoTax === 1 ? 'line carries' : 'lines carry'} VAT, which is left off the return; check the rate on ${taxOnNoTax === 1 ? 'it' : 'them'}`);
  const invoiced = v.tax19.plus(v.tax7);
  if (invoiced.minus(output).abs().gt(1)) warnings.push(`The VAT on your invoices (EUR ${invoiced.toFixed(2)}) differs by more than EUR 1 from the tax the form works out from Kz 81 and 86 (EUR ${output.toFixed(2)}); check the rates on the invoices`);
  for (const r of rates) {
    if (!used.has(r.id)) continue;
    const t = r.treatment ?? suggestDeTreatment(r.rate, r.name);
    const want = t ? DE_VAT_RATE[t] : undefined;
    if (want && !new D(r.rate).eq(want)) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as ${DE_TREATMENT_LABEL[t!].toLowerCase()}, which is ${want}% in Germany`);
    if (t && !want && !new D(r.rate).isZero()) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as ${DE_TREATMENT_LABEL[t].toLowerCase()}`);
  }
  const issues = [...unclassified.values()].map((u) => `Choose the VAT treatment of ${u.name} (${new D(u.rate).toFixed()}%, ${u.lines} ${u.lines === 1 ? 'line' : 'lines'})`);
  const order = (s: string) => (s.startsWith('SALES') ? 0 : 10) + DE_VAT_TREATMENTS.indexOf(s.split(':')[1] as (typeof DE_VAT_TREATMENTS)[number]); // not money: sort key
  return {
    boxes,
    direction: (output.gt(v.input) ? 'PAY' : output.lt(v.input) ? 'RECLAIM' : 'NIL') as 'PAY' | 'RECLAIM' | 'NIL',
    own: { output: output.toFixed(2), input: v.input.toFixed(2), supplies: v.s19.plus(v.s7).plus(v.zero).plus(v.exempt).toFixed(2), purchases: v.purchases.toFixed(2) },
    breakdown: [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([, g]) => ({ side: g.side, treatment: g.treatment, label: DE_TREATMENT_LABEL[g.treatment], net: g.net.toFixed(2), vat: g.vat.toFixed(2), lines: g.lines, counted: g.side === 'SALES' ? g.treatment !== 'OUTSIDE_SCOPE' : g.treatment === 'STANDARD' || g.treatment === 'REDUCED' })),
    unclassified: [...unclassified.values()],
    issues,
    warnings,
  };
}

/** A change to an advance return already filed is made on a corrected return for that period, never on a later one. */
export function deCorrectionAllowance(corrections: readonly { output: string; input: string }[]) {
  const net = corrections.reduce((a, c) => a.plus(c.output).minus(c.input), new D(0));
  return { net: net.toFixed(2), limit: '0.00', allowed: corrections.length === 0 };
}
