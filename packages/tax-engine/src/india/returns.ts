import { D, Dec, dec } from '@talk2tax/accounting-engine';
import type { GstCategory, SupplyNature } from './gst';
import { FOREIGN_PLACE_OF_SUPPLY } from './states';

/**
 * Return summaries computed from posted documents (GSTR-1 for outward supplies,
 * GSTR-3B for the monthly summary and tax payment). These are working papers:
 * they are not the GSTN JSON upload format and nothing here files a return.
 *
 * Amounts are in rupees as decimal strings. Credit notes reduce the period they
 * are issued in, like the returns themselves.
 */

export interface GstReturnLine {
  hsnCode: string | null;
  quantity: string;
  category: GstCategory;
  /** Full GST rate in percent, e.g. "18". */
  rate: string;
  /** Taxable value (the line's net amount). */
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
}

export interface GstReturnDocument {
  id: string;
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT';
  status: 'POSTED' | 'VOID';
  number: string;
  issueDate: string;
  contactName: string;
  /** Counterparty GSTIN as it was when the document was saved; null = unregistered. */
  gstin: string | null;
  placeOfSupply: string;
  nature: SupplyNature;
  /** Invoice value: taxable value plus GST charged (income-tax TCS is not part of it). */
  total: string;
  /** Purchases only: the buyer pays the GST (reverse charge). */
  reverseCharge?: boolean;
  /** The supplier's state; 96 for a supplier outside India (import of services). */
  supplierState?: string;
  /** Sales: an INVOICE that is a debit note on an earlier invoice (CGST Act s.34(3)), with that invoice's number. */
  debitNote?: boolean;
  originalNumber?: string | null;
  lines: GstReturnLine[];
}

export interface TaxHeads {
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
}

interface Acc {
  taxable: Dec;
  igst: Dec;
  cgst: Dec;
  sgst: Dec;
}

const zero = (): Acc => ({ taxable: new D(0), igst: new D(0), cgst: new D(0), sgst: new D(0) });
const add = (a: Acc, l: GstReturnLine, sign: 1 | -1) => {
  a.taxable = a.taxable.plus(dec(l.taxable).times(sign));
  a.igst = a.igst.plus(dec(l.igst).times(sign));
  a.cgst = a.cgst.plus(dec(l.cgst).times(sign));
  a.sgst = a.sgst.plus(dec(l.sgst).times(sign));
};
const out = (a: Acc): TaxHeads => ({ taxable: a.taxable.toFixed(2), igst: a.igst.toFixed(2), cgst: a.cgst.toFixed(2), sgst: a.sgst.toFixed(2) });
const rateKey = (r: string) => dec(r).toFixed();

function rateRows(lines: GstReturnLine[]): (TaxHeads & { rate: string })[] {
  const m = new Map<string, Acc>();
  for (const l of lines) {
    if (l.category !== 'TAXABLE') continue;
    const k = rateKey(l.rate);
    if (!m.has(k)) m.set(k, zero());
    add(m.get(k)!, l, 1);
  }
  return [...m.entries()].sort((a, b) => dec(a[0]).comparedTo(dec(b[0]))).map(([rate, a]) => ({ rate, ...out(a) }));
}

// ---------------------------------------------------------------- GSTR-1

export interface Gstr1DocumentRow {
  id: string;
  number: string;
  date: string;
  name: string;
  gstin: string | null;
  placeOfSupply: string;
  value: string;
  rates: (TaxHeads & { rate: string })[];
  /** Tables 9B: C for a credit note, D for a debit note. Absent on invoices. */
  noteType?: 'C' | 'D';
  /** Debit notes: the invoice they adjust. */
  originalNumber?: string | null;
}

export interface Gstr1Summary {
  /** Table 4: taxable supplies to registered persons. */
  b2b: Gstr1DocumentRow[];
  /** Table 5: inter-state invoices to unregistered persons above the B2CL threshold. */
  b2cl: Gstr1DocumentRow[];
  /** Table 6A: exports (place of supply outside India). Only export with payment of IGST is supported. */
  exp: Gstr1DocumentRow[];
  /** Table 7: all other supplies to unregistered persons, by place of supply and rate, net of their credit notes. */
  b2cs: (TaxHeads & { placeOfSupply: string; nature: SupplyNature; rate: string })[];
  /** Table 9B: credit and debit notes to registered persons. */
  cdnr: Gstr1DocumentRow[];
  /** Table 9B: credit and debit notes to unregistered persons on inter-state supplies above the B2CL threshold, and on exports. */
  cdnur: Gstr1DocumentRow[];
  /** Table 8: nil-rated, exempt and non-GST supplies. */
  nil: { nature: SupplyNature; registered: boolean; nilRated: string; exempt: string; nonGst: string }[];
  /** Table 12: HSN-wise summary, split into supplies to registered (B2B) and unregistered (B2C) recipients. */
  hsn: { b2b: HsnRow[]; b2c: HsnRow[] };
  /** Table 13: documents issued. */
  documents: { kind: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE'; from: string; to: string; issued: number; cancelled: number }[];
  totals: TaxHeads;
}

export interface HsnRow extends TaxHeads {
  hsnCode: string;
  rate: string;
  quantity: string;
}

export interface Gstr1Options {
  /** Invoice value above which an inter-state B2C invoice is reported invoice-wise (B2CL). Rs 1 lakh since August 2024. */
  b2clThreshold?: string;
}

export function gstr1Summary(documents: readonly GstReturnDocument[], options: Gstr1Options = {}): Gstr1Summary {
  const threshold = dec(options.b2clThreshold ?? '100000');
  const sales = documents.filter((d) => d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE');
  const posted = sales.filter((d) => d.status === 'POSTED');
  const isExport = (d: GstReturnDocument) => d.placeOfSupply === FOREIGN_PLACE_OF_SUPPLY;
  const isLarge = (d: GstReturnDocument) => !d.gstin && !isExport(d) && d.nature === 'INTER' && dec(d.total).gt(threshold);
  const row = (d: GstReturnDocument): Gstr1DocumentRow => ({ id: d.id, number: d.number, date: d.issueDate, name: d.contactName, gstin: d.gstin, placeOfSupply: d.placeOfSupply, value: dec(d.total).toFixed(2), rates: rateRows(d.lines) });
  const hasTaxable = (d: GstReturnDocument) => d.lines.some((l) => l.category === 'TAXABLE');
  const byDate = (a: Gstr1DocumentRow, b: Gstr1DocumentRow) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number);

  const b2b: Gstr1DocumentRow[] = [];
  const b2cl: Gstr1DocumentRow[] = [];
  const exp: Gstr1DocumentRow[] = [];
  const cdnr: Gstr1DocumentRow[] = [];
  const cdnur: Gstr1DocumentRow[] = [];
  const b2cs = new Map<string, Acc & { placeOfSupply: string; nature: SupplyNature; rate: string }>();
  const nil = new Map<string, { nature: SupplyNature; registered: boolean; nilRated: Dec; exempt: Dec; nonGst: Dec }>();
  const hsn = { b2b: new Map<string, Acc & { hsnCode: string; rate: string; quantity: Dec }>(), b2c: new Map<string, Acc & { hsnCode: string; rate: string; quantity: Dec }>() };
  const totals = zero();

  for (const d of posted) {
    const sign = d.kind === 'INVOICE' ? 1 : -1;
    const registered = !!d.gstin;
    if (hasTaxable(d)) {
      if (d.kind === 'INVOICE' && !d.debitNote) {
        if (isExport(d)) exp.push(row(d));
        else if (registered) b2b.push(row(d));
        else if (isLarge(d)) b2cl.push(row(d));
      } else {
        const note: Gstr1DocumentRow = { ...row(d), noteType: d.kind === 'INVOICE' ? 'D' : 'C', ...(d.debitNote ? { originalNumber: d.originalNumber ?? null } : {}) };
        if (registered && !isExport(d)) cdnr.push(note);
        else if (isLarge(d) || isExport(d)) cdnur.push(note);
      }
      if (!registered && !isLarge(d) && !isExport(d)) {
        for (const l of d.lines) {
          if (l.category !== 'TAXABLE') continue;
          const k = `${d.placeOfSupply}|${rateKey(l.rate)}`;
          if (!b2cs.has(k)) b2cs.set(k, { ...zero(), placeOfSupply: d.placeOfSupply, nature: d.nature, rate: rateKey(l.rate) });
          add(b2cs.get(k)!, l, sign);
        }
      }
    }
    for (const l of d.lines) {
      if (l.category === 'TAXABLE') add(totals, l, sign);
      else {
        const k = `${d.nature}|${registered}`;
        if (!nil.has(k)) nil.set(k, { nature: d.nature, registered, nilRated: new D(0), exempt: new D(0), nonGst: new D(0) });
        const n = nil.get(k)!;
        const v = dec(l.taxable).times(sign);
        if (l.category === 'NIL_RATED') n.nilRated = n.nilRated.plus(v);
        else if (l.category === 'EXEMPT') n.exempt = n.exempt.plus(v);
        else n.nonGst = n.nonGst.plus(v);
      }
      if (l.category !== 'NON_GST' && l.hsnCode) {
        const table = registered ? hsn.b2b : hsn.b2c;
        const k = `${l.hsnCode}|${rateKey(l.rate)}`;
        if (!table.has(k)) table.set(k, { ...zero(), hsnCode: l.hsnCode, rate: rateKey(l.rate), quantity: new D(0) });
        const h = table.get(k)!;
        add(h, l, sign);
        h.quantity = h.quantity.plus(dec(l.quantity).times(sign));
      }
    }
  }

  const series = (d: GstReturnDocument) => (d.kind === 'INVOICE' && d.debitNote ? 'DEBIT_NOTE' : d.kind);
  const docSeries = (['INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE'] as const)
    .map((kind) => {
      const all = sales.filter((d) => series(d) === kind).map((d) => d.number).sort();
      return { kind, from: all[0] ?? '', to: all[all.length - 1] ?? '', issued: all.length, cancelled: sales.filter((d) => series(d) === kind && d.status === 'VOID').length };
    })
    .filter((x) => x.issued > 0);

  const hsnRows = (m: Map<string, Acc & { hsnCode: string; rate: string; quantity: Dec }>): HsnRow[] =>
    [...m.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || dec(a.rate).comparedTo(dec(b.rate))).map((h) => ({ hsnCode: h.hsnCode, rate: h.rate, quantity: h.quantity.toFixed(), ...out(h) }));

  return {
    b2b: b2b.sort(byDate),
    b2cl: b2cl.sort(byDate),
    exp: exp.sort(byDate),
    b2cs: [...b2cs.values()].sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || dec(a.rate).comparedTo(dec(b.rate))).map((x) => ({ placeOfSupply: x.placeOfSupply, nature: x.nature, rate: x.rate, ...out(x) })),
    cdnr: cdnr.sort(byDate),
    cdnur: cdnur.sort(byDate),
    nil: [...nil.values()]
      .sort((a, b) => a.nature.localeCompare(b.nature) || Number(b.registered) - Number(a.registered))
      .map((n) => ({ nature: n.nature, registered: n.registered, nilRated: n.nilRated.toFixed(2), exempt: n.exempt.toFixed(2), nonGst: n.nonGst.toFixed(2) })),
    hsn: { b2b: hsnRows(hsn.b2b), b2c: hsnRows(hsn.b2c) },
    documents: docSeries,
    totals: out(totals),
  };
}

// ---------------------------------------------------------------- ITC set-off

export interface Heads {
  igst: string;
  cgst: string;
  sgst: string;
}

export interface SetOff {
  liability: Heads;
  credit: Heads;
  /** Credit used, by credit head then liability head. CGST never pays SGST and SGST never pays CGST. */
  used: { igst: Heads; cgst: Heads; sgst: Heads };
  cash: Heads;
  carryForward: Heads;
}

/**
 * Uses input tax credit against output tax in the order the CGST Act requires
 * (s.49(5), s.49A, rule 88A): IGST credit first, against IGST and then against
 * CGST and SGST/UTGST; only then CGST credit (against CGST, then IGST) and
 * SGST/UTGST credit (against SGST/UTGST, then IGST). Within those rules, IGST
 * credit left after IGST goes first to the head whose own credit falls short,
 * so no cash is paid while usable credit is left over. Negative inputs are
 * treated as zero.
 */
export function setOffItc(liability: Heads, credit: Heads): SetOff {
  const pos = (v: string) => D.max(dec(v), 0);
  const L = { igst: pos(liability.igst), cgst: pos(liability.cgst), sgst: pos(liability.sgst) };
  const C = { igst: pos(credit.igst), cgst: pos(credit.cgst), sgst: pos(credit.sgst) };
  const used = {
    igst: { igst: new D(0), cgst: new D(0), sgst: new D(0) },
    cgst: { igst: new D(0), cgst: new D(0), sgst: new D(0) },
    sgst: { igst: new D(0), cgst: new D(0), sgst: new D(0) },
  };
  const take = (from: keyof typeof C, to: keyof typeof L, max?: Dec) => {
    let amount = D.min(C[from], L[to]);
    if (max) amount = D.min(amount, max);
    if (amount.lte(0)) return;
    C[from] = C[from].minus(amount);
    L[to] = L[to].minus(amount);
    used[from][to] = used[from][to].plus(amount);
  };
  take('igst', 'igst');
  take('igst', 'cgst', D.max(L.cgst.minus(C.cgst), 0));
  take('igst', 'sgst', D.max(L.sgst.minus(C.sgst), 0));
  take('igst', 'cgst');
  take('igst', 'sgst');
  take('cgst', 'cgst');
  take('cgst', 'igst');
  take('sgst', 'sgst');
  take('sgst', 'igst');
  const h = (x: { igst: Dec; cgst: Dec; sgst: Dec }): Heads => ({ igst: x.igst.toFixed(2), cgst: x.cgst.toFixed(2), sgst: x.sgst.toFixed(2) });
  return {
    liability: h({ igst: pos(liability.igst), cgst: pos(liability.cgst), sgst: pos(liability.sgst) }),
    credit: h({ igst: pos(credit.igst), cgst: pos(credit.cgst), sgst: pos(credit.sgst) }),
    used: { igst: h(used.igst), cgst: h(used.cgst), sgst: h(used.sgst) },
    cash: h(L),
    carryForward: h(C),
  };
}

// ---------------------------------------------------------------- GSTR-3B

export interface Gstr3bSummary {
  /** 3.1(a) outward taxable supplies (other than zero-rated, nil-rated and exempt). */
  outwardTaxable: TaxHeads;
  /** 3.1(b) zero-rated outward supplies: exports (with payment of IGST). */
  outwardZeroRated: { taxable: string; igst: string };
  /** 3.1(c) other outward supplies: nil-rated and exempt. */
  outwardNilExempt: string;
  /** 3.1(e) non-GST outward supplies. */
  outwardNonGst: string;
  /** 3.2 inter-state supplies to unregistered persons, by place of supply. */
  interStateUnregistered: { placeOfSupply: string; taxable: string; igst: string }[];
  /** 3.1(d) inward supplies liable to reverse charge: taxable value and the tax the organisation owes on them. */
  inwardReverseCharge: TaxHeads;
  /** 4(A)(2) ITC on import of services (reverse charge on a supplier outside India). */
  itcImportServices: Heads;
  /** 4(A)(3) ITC on inward supplies liable to reverse charge (other than imports). */
  itcReverseCharge: Heads;
  /** 4(A)(5) all other ITC, net of vendor credit notes. */
  itc: Heads;
  /** 4(C) net ITC available: the three lines above (no reversals are modelled). */
  itcTotal: Heads;
  /** Reverse-charge tax is paid in cash (CGST Act s.49(4)); credit cannot pay it. */
  reverseChargeCash: Heads;
  /** 5: inward exempt, nil-rated and non-GST supplies. */
  inwardExempt: { inter: string; intra: string };
  inwardNonGst: { inter: string; intra: string };
  /** 6.1 payment of tax. */
  setOff: SetOff;
  /** Net outward tax was negative for a head (more credit notes than invoices); returns cannot show negatives. */
  warnings: string[];
}

export function gstr3bSummary(documents: readonly GstReturnDocument[]): Gstr3bSummary {
  const posted = documents.filter((d) => d.status === 'POSTED');
  const outward = zero();
  const zeroRated = zero();
  let nilExempt = new D(0);
  let nonGst = new D(0);
  const interUnreg = new Map<string, { taxable: Dec; igst: Dec }>();
  const itc = zero();
  const rcm = zero();
  const itcImport = zero();
  const itcRcm = zero();
  const inward = { exempt: { INTER: new D(0), INTRA: new D(0) }, nonGst: { INTER: new D(0), INTRA: new D(0) } };

  for (const d of posted) {
    const sales = d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE';
    const sign = d.kind === 'INVOICE' || d.kind === 'BILL' ? 1 : -1;
    for (const l of d.lines) {
      const v = dec(l.taxable).times(sign);
      if (sales) {
        if (l.category === 'TAXABLE' && d.placeOfSupply === FOREIGN_PLACE_OF_SUPPLY) {
          add(zeroRated, l, sign);
        } else if (l.category === 'TAXABLE') {
          add(outward, l, sign);
          if (!d.gstin && d.nature === 'INTER') {
            const e = interUnreg.get(d.placeOfSupply) ?? { taxable: new D(0), igst: new D(0) };
            e.taxable = e.taxable.plus(v);
            e.igst = e.igst.plus(dec(l.igst).times(sign));
            interUnreg.set(d.placeOfSupply, e);
          }
        } else if (l.category === 'NON_GST') nonGst = nonGst.plus(v);
        else nilExempt = nilExempt.plus(v);
      } else {
        if (l.category === 'TAXABLE' && d.reverseCharge) {
          add(rcm, l, sign);
          add(d.supplierState === FOREIGN_PLACE_OF_SUPPLY ? itcImport : itcRcm, l, sign);
        } else if (l.category === 'TAXABLE') add(itc, l, sign);
        else if (l.category === 'NON_GST') inward.nonGst[d.nature] = inward.nonGst[d.nature].plus(v);
        else inward.exempt[d.nature] = inward.exempt[d.nature].plus(v);
      }
    }
  }
  const warnings: string[] = [];
  const payable = { igst: outward.igst.plus(zeroRated.igst), cgst: outward.cgst, sgst: outward.sgst };
  for (const head of ['igst', 'cgst', 'sgst'] as const) {
    if (payable[head].isNegative()) warnings.push(`Credit notes exceed invoices for ${head.toUpperCase()} this period; the payable is shown as zero.`);
    if (itc[head].isNegative()) warnings.push(`Vendor credits exceed bills for ${head.toUpperCase()} this period; this is a reversal of input tax credit, shown here as zero credit.`);
    if (rcm[head].isNegative()) warnings.push(`Vendor credits exceed reverse-charge bills for ${head.toUpperCase()} this period; the reverse-charge tax is shown as zero.`);
  }
  const heads = (a: Acc): Heads => ({ igst: a.igst.toFixed(2), cgst: a.cgst.toFixed(2), sgst: a.sgst.toFixed(2) });
  const posHeads = (a: Acc): Heads => ({ igst: D.max(a.igst, 0).toFixed(2), cgst: D.max(a.cgst, 0).toFixed(2), sgst: D.max(a.sgst, 0).toFixed(2) });
  const itcAll = { taxable: new D(0), igst: itc.igst.plus(itcImport.igst).plus(itcRcm.igst), cgst: itc.cgst.plus(itcImport.cgst).plus(itcRcm.cgst), sgst: itc.sgst.plus(itcImport.sgst).plus(itcRcm.sgst) };
  return {
    outwardTaxable: out(outward),
    outwardZeroRated: { taxable: zeroRated.taxable.toFixed(2), igst: zeroRated.igst.toFixed(2) },
    outwardNilExempt: nilExempt.toFixed(2),
    outwardNonGst: nonGst.toFixed(2),
    interStateUnregistered: [...interUnreg.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([placeOfSupply, x]) => ({ placeOfSupply, taxable: x.taxable.toFixed(2), igst: x.igst.toFixed(2) })),
    inwardReverseCharge: out(rcm),
    itcImportServices: heads(itcImport),
    itcReverseCharge: heads(itcRcm),
    itc: heads(itc),
    itcTotal: heads(itcAll),
    reverseChargeCash: posHeads(rcm),
    inwardExempt: { inter: inward.exempt.INTER.toFixed(2), intra: inward.exempt.INTRA.toFixed(2) },
    inwardNonGst: { inter: inward.nonGst.INTER.toFixed(2), intra: inward.nonGst.INTRA.toFixed(2) },
    setOff: setOffItc({ igst: payable.igst.toFixed(), cgst: payable.cgst.toFixed(), sgst: payable.sgst.toFixed() }, { igst: itcAll.igst.toFixed(), cgst: itcAll.cgst.toFixed(), sgst: itcAll.sgst.toFixed() }),
    warnings,
  };
}
