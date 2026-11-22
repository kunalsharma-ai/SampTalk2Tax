import { D, Dec, dec } from '@talk2tax/accounting-engine';
import { checkGstin } from './gstin';
import type { GstReturnDocument, Heads } from './returns';
import { FOREIGN_PLACE_OF_SUPPLY } from './states';

/**
 * GST reconciliation (TAX-045) and discrepancy checks (TAX-044).
 *
 * Reconciliation: what the GST accounts moved in a period against what the period's documents
 * say (the GSTR-3B figures). Output accounts carry tax on sales and reverse-charge tax; input
 * accounts carry input tax credit. GST payments settle the accounts and are shown apart. Every
 * other movement is explained entry by entry, so the explained items always add up to the
 * difference: a manual journal, a document issued in another period but posted in this one, a
 * document voided later, a posting that differs from its document.
 *
 * Discrepancy checks: each document of the period is checked for tax in the wrong heads, tax that
 * is not the rate on the value, tax on exempt lines, GSTIN problems, input tax claimed without the
 * supplier's GSTIN, missing HSN codes and one HSN sold at different rates.
 *
 * Amounts are rupees as decimal strings. Nothing here changes the books or files anything.
 */

export const GST_RECON_HEADS = ['igst', 'cgst', 'sgst'] as const;
export type GstReconHead = (typeof GST_RECON_HEADS)[number];
/** Movement on the output (credit side up) and input (debit side up) GST accounts. */
export interface GstSides {
  output: Heads;
  input: Heads;
}

export interface GstReconDocument extends GstReturnDocument {
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
}

export interface GstReconEntry {
  id: string;
  number: number | null;
  date: string;
  /** The journal's source: MANUAL, DOCUMENT, PAYMENT, … */
  source: string;
  memo: string | null;
  gst: GstSides;
}

export type GstReconItemKind = 'OTHER_ENTRY' | 'ISSUED_OUTSIDE_PERIOD' | 'VOID_OF_EARLIER_DOCUMENT' | 'VOIDED_DOCUMENT' | 'POSTED_OUTSIDE_PERIOD' | 'POSTING_DIFFERS';

export interface GstReconItem {
  kind: GstReconItemKind;
  date: string;
  entryId: string | null;
  entryNumber: number | null;
  documentId: string | null;
  documentKind: GstReturnDocument['kind'] | null;
  documentNumber: string | null;
  /** What this item adds to the ledger compared with the documents. */
  effect: GstSides;
  message: string;
}

export const GST_RECON_ITEM_LABEL: Record<GstReconItemKind, string> = {
  OTHER_ENTRY: 'Journal with no document',
  ISSUED_OUTSIDE_PERIOD: 'Document from another period',
  VOID_OF_EARLIER_DOCUMENT: 'Earlier document voided',
  VOIDED_DOCUMENT: 'Document voided',
  POSTED_OUTSIDE_PERIOD: 'Posted in another period',
  POSTING_DIFFERS: 'Posting differs from document',
};

const zeroHeads = () => ({ igst: new D(0), cgst: new D(0), sgst: new D(0) });
type DecSides = { output: Record<GstReconHead, Dec>; input: Record<GstReconHead, Dec> };
const zeroSides = (): DecSides => ({ output: zeroHeads(), input: zeroHeads() });
const toDec = (s: GstSides): DecSides => ({ output: { igst: dec(s.output.igst), cgst: dec(s.output.cgst), sgst: dec(s.output.sgst) }, input: { igst: dec(s.input.igst), cgst: dec(s.input.cgst), sgst: dec(s.input.sgst) } });
const fmt = (s: DecSides): GstSides => ({
  output: { igst: s.output.igst.toFixed(2), cgst: s.output.cgst.toFixed(2), sgst: s.output.sgst.toFixed(2) },
  input: { igst: s.input.igst.toFixed(2), cgst: s.input.cgst.toFixed(2), sgst: s.input.sgst.toFixed(2) },
});
const combine = (a: DecSides, b: DecSides, sign = 1): DecSides => {
  const out = zeroSides();
  for (const side of ['output', 'input'] as const) for (const h of GST_RECON_HEADS) out[side][h] = a[side][h].plus(b[side][h].times(sign));
  return out;
};
const isZero = (s: DecSides) => (['output', 'input'] as const).every((side) => GST_RECON_HEADS.every((h) => s[side][h].isZero()));
const total = (s: DecSides) => (['output', 'input'] as const).reduce((t, side) => t.plus(GST_RECON_HEADS.reduce((u, h) => u.plus(s[side][h].abs()), new D(0))), new D(0));

/** What a document should put on the GST accounts: sales tax on output, input tax credit on input, reverse charge on both. */
export function documentGstSides(d: Pick<GstReturnDocument, 'kind' | 'reverseCharge' | 'lines'>): GstSides {
  const s = zeroSides();
  const sign = d.kind === 'INVOICE' || d.kind === 'BILL' ? 1 : -1;
  const sales = d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE';
  for (const l of d.lines) {
    for (const h of GST_RECON_HEADS) {
      const v = dec(l[h]).times(sign);
      if (sales) s.output[h] = s.output[h].plus(v);
      else {
        s.input[h] = s.input[h].plus(v);
        if (d.reverseCharge) s.output[h] = s.output[h].plus(v);
      }
    }
  }
  return fmt(s);
}

const KIND_NAME: Record<GstReturnDocument['kind'], string> = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', BILL: 'Bill', VENDOR_CREDIT: 'Vendor credit' };
const inPeriod = (date: string, from: string, to: string) => date >= from && date <= to;

export interface GstReconciliationInput {
  from: string;
  to: string;
  /** Documents issued in the period, and any document whose posting or void entry is in it. */
  documents: GstReconDocument[];
  /** Posted journal entries in the period with a line on a GST account. */
  entries: GstReconEntry[];
  /** Entries of GST payments (and their reversals): they settle the accounts, so they are shown apart. */
  settlementEntryIds: ReadonlySet<string>;
}

export function gstReconciliation(input: GstReconciliationInput) {
  const { from, to } = input;
  const period = input.documents.filter((d) => inPeriod(d.issueDate, from, to));
  const byPosting = new Map(input.documents.filter((d) => d.journalEntryId).map((d) => [d.journalEntryId!, d]));
  const byVoid = new Map(input.documents.filter((d) => d.voidJournalEntryId).map((d) => [d.voidJournalEntryId!, d]));
  const entryIds = new Set(input.entries.map((e) => e.id));

  let returns = zeroSides();
  for (const d of period) if (d.status === 'POSTED') returns = combine(returns, toDec(documentGstSides(d)));
  let ledger = zeroSides();
  let settled = zeroSides();
  const items: GstReconItem[] = [];
  const label = (d: GstReturnDocument) => `${KIND_NAME[d.kind]} ${d.number}`;

  for (const e of [...input.entries].sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? 0) - (b.number ?? 0))) {
    const g = toDec(e.gst);
    if (input.settlementEntryIds.has(e.id)) {
      settled = combine(settled, g);
      continue;
    }
    ledger = combine(ledger, g);
    const posted = byPosting.get(e.id);
    const voided = byVoid.get(e.id);
    const doc = posted ?? voided ?? null;
    const base = { date: e.date, entryId: e.id, entryNumber: e.number, documentId: doc?.id ?? null, documentKind: doc?.kind ?? null, documentNumber: doc?.number ?? null };
    if (posted && inPeriod(posted.issueDate, from, to) && posted.status === 'POSTED') {
      const diff = combine(g, toDec(documentGstSides(posted)), -1);
      if (!isZero(diff)) items.push({ ...base, kind: 'POSTING_DIFFERS', effect: fmt(diff), message: `${label(posted)} put different GST on the accounts than its lines show; check the GST accounts in Settings → GST were the same when it posted` });
      continue;
    }
    if (isZero(g)) continue;
    if (posted && inPeriod(posted.issueDate, from, to)) {
      const voidIn = !!posted.voidJournalEntryId && entryIds.has(posted.voidJournalEntryId);
      if (!voidIn) items.push({ ...base, kind: 'VOIDED_DOCUMENT', effect: fmt(g), message: `${label(posted)} was voided after this period; its GST stays in this period's accounts until the void` });
      else items.push({ ...base, kind: 'VOIDED_DOCUMENT', effect: fmt(g), message: `${label(posted)} was posted and voided in this period` });
    } else if (voided && inPeriod(voided.issueDate, from, to)) {
      items.push({ ...base, kind: 'VOIDED_DOCUMENT', effect: fmt(g), message: `Void of ${label(voided)}` });
    } else if (posted) {
      items.push({ ...base, kind: 'ISSUED_OUTSIDE_PERIOD', effect: fmt(g), message: `${label(posted)} is dated ${posted.issueDate} but posted in this period; it belongs to that period's return` });
    } else if (voided) {
      items.push({ ...base, kind: 'VOID_OF_EARLIER_DOCUMENT', effect: fmt(g), message: `${label(voided)} of ${voided.issueDate} was voided in this period; amend the return of its own period` });
    } else {
      items.push({ ...base, kind: 'OTHER_ENTRY', effect: fmt(g), message: `${e.number ? `Journal ${e.number}` : 'A journal'} (${e.source.toLowerCase().replace(/_/g, ' ')}${e.memo ? `: ${e.memo}` : ''}) moved a GST account with no document behind it` });
    }
  }
  for (const d of period) {
    if (d.status !== 'POSTED' || (d.journalEntryId && entryIds.has(d.journalEntryId))) continue;
    const expected = toDec(documentGstSides(d));
    if (isZero(expected)) continue;
    items.push({ kind: 'POSTED_OUTSIDE_PERIOD', date: d.issueDate, entryId: d.journalEntryId, entryNumber: null, documentId: d.id, documentKind: d.kind, documentNumber: d.number, effect: fmt(combine(zeroSides(), expected, -1)), message: `${label(d)} is dated in this period but its posting is not; the return counts it here, the accounts do not` });
  }

  const difference = combine(ledger, returns, -1);
  const explained = items.reduce((s, i) => combine(s, toDec(i.effect)), zeroSides());
  const unexplained = combine(difference, explained, -1);
  items.sort((a, b) => total(toDec(b.effect)).comparedTo(total(toDec(a.effect))) || a.date.localeCompare(b.date));
  return {
    from,
    to,
    returns: fmt(returns),
    ledger: fmt(ledger),
    settled: fmt(settled),
    difference: fmt(difference),
    unexplained: fmt(unexplained),
    agrees: isZero(difference),
    items,
  };
}

// --------------------------------------------------------------- discrepancy checks (TAX-044)

export type GstDiscrepancyKind =
  | 'WRONG_TAX_HEADS'
  | 'CGST_SGST_UNEQUAL'
  | 'TAX_ON_EXEMPT'
  | 'TAX_NOT_AT_RATE'
  | 'INVALID_GSTIN'
  | 'GSTIN_STATE_MISMATCH'
  | 'ITC_WITHOUT_SUPPLIER_GSTIN'
  | 'MISSING_HSN'
  | 'HSN_RATE_VARIES';
export type GstDiscrepancySeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export const GST_DISCREPANCY_LABEL: Record<GstDiscrepancyKind, string> = {
  WRONG_TAX_HEADS: 'Wrong tax heads',
  CGST_SGST_UNEQUAL: 'CGST and SGST differ',
  TAX_ON_EXEMPT: 'Tax on exempt supply',
  TAX_NOT_AT_RATE: 'Tax not at the rate',
  INVALID_GSTIN: 'Invalid GSTIN',
  GSTIN_STATE_MISMATCH: 'GSTIN state differs',
  ITC_WITHOUT_SUPPLIER_GSTIN: 'Credit without supplier GSTIN',
  MISSING_HSN: 'HSN code missing',
  HSN_RATE_VARIES: 'HSN at different rates',
};
const SEVERITY: Record<GstDiscrepancyKind, GstDiscrepancySeverity> = {
  WRONG_TAX_HEADS: 'HIGH',
  CGST_SGST_UNEQUAL: 'HIGH',
  TAX_ON_EXEMPT: 'HIGH',
  INVALID_GSTIN: 'HIGH',
  ITC_WITHOUT_SUPPLIER_GSTIN: 'HIGH',
  TAX_NOT_AT_RATE: 'MEDIUM',
  GSTIN_STATE_MISMATCH: 'MEDIUM',
  MISSING_HSN: 'LOW',
  HSN_RATE_VARIES: 'LOW',
};
/** Rupees of difference between the tax and the rate on the value before a line is flagged (rounding is per head). */
export const GST_RATE_TOLERANCE = '1.00';

export interface GstDiscrepancy {
  kind: GstDiscrepancyKind;
  severity: GstDiscrepancySeverity;
  documentId: string | null;
  documentKind: GstReturnDocument['kind'] | null;
  documentNumber: string | null;
  date: string | null;
  lineNo: number | null;
  /** Tax concerned, where there is one. */
  amount: string | null;
  message: string;
}

export function gstDiscrepancies(documents: readonly GstReturnDocument[]): GstDiscrepancy[] {
  const out: GstDiscrepancy[] = [];
  const tol = dec(GST_RATE_TOLERANCE);
  const hsnRates = new Map<string, Map<string, string[]>>();
  for (const d of documents) {
    if (d.status !== 'POSTED') continue;
    const sales = d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE';
    const at = (kind: GstDiscrepancyKind, message: string, lineNo: number | null = null, amount: Dec | null = null) =>
      out.push({ kind, severity: SEVERITY[kind], documentId: d.id, documentKind: d.kind, documentNumber: d.number, date: d.issueDate, lineNo, amount: amount ? amount.toFixed(2) : null, message });
    const name = `${KIND_NAME[d.kind]} ${d.number}`;
    let inputTax = new D(0);
    d.lines.forEach((l, i) => {
      const n = i + 1; // not money
      const cgst = dec(l.cgst);
      const sgst = dec(l.sgst);
      const igst = dec(l.igst);
      const tax = cgst.plus(sgst).plus(igst);
      inputTax = inputTax.plus(tax);
      if (l.category !== 'TAXABLE') {
        if (!tax.isZero()) at('TAX_ON_EXEMPT', `${name} line ${n} is ${l.category.toLowerCase().replace('_', '-')} but carries GST`, n, tax);
        return;
      }
      if (d.nature === 'INTRA' && !igst.isZero()) at('WRONG_TAX_HEADS', `${name} line ${n}: a supply within the state carries IGST; it should be CGST and SGST`, n, igst);
      if (d.nature === 'INTER' && !cgst.plus(sgst).isZero()) at('WRONG_TAX_HEADS', `${name} line ${n}: a supply between states${d.placeOfSupply === FOREIGN_PLACE_OF_SUPPLY ? ' or an export' : ''} carries CGST and SGST; it should be IGST`, n, cgst.plus(sgst));
      if (!cgst.eq(sgst)) at('CGST_SGST_UNEQUAL', `${name} line ${n}: CGST ${cgst.toFixed(2)} and SGST ${sgst.toFixed(2)} should be equal halves`, n, cgst.minus(sgst).abs());
      const expected = dec(l.taxable).times(dec(l.rate)).div(100);
      // A zero-rated export without payment of IGST legitimately carries no tax.
      const exportWithoutTax = d.placeOfSupply === FOREIGN_PLACE_OF_SUPPLY && tax.isZero();
      if (!exportWithoutTax && tax.minus(expected).abs().gt(tol)) at('TAX_NOT_AT_RATE', `${name} line ${n}: GST ${tax.toFixed(2)} is not ${l.rate}% of ${dec(l.taxable).toFixed(2)} (${expected.toFixed(2)})`, n, tax.minus(expected).abs());
      if (sales) {
        if (!l.hsnCode) at('MISSING_HSN', `${name} line ${n} has no HSN or SAC code; invoices and GSTR-1 need one`, n);
        else {
          const rates = hsnRates.get(l.hsnCode) ?? new Map<string, string[]>();
          const r = dec(l.rate).toFixed();
          rates.set(r, [...(rates.get(r) ?? []), d.number]);
          hsnRates.set(l.hsnCode, rates);
        }
      }
    });
    if (d.gstin) {
      const g = checkGstin(d.gstin);
      if (!g.valid) at('INVALID_GSTIN', `${name}: GSTIN ${d.gstin} is not valid (${g.issues.join('; ')})`);
      else if (!sales && d.supplierState && d.supplierState !== FOREIGN_PLACE_OF_SUPPLY && g.stateCode !== d.supplierState) at('GSTIN_STATE_MISMATCH', `${name}: the supplier's GSTIN is registered in state ${g.stateCode}, but the bill says the supplier is in ${d.supplierState}`);
    }
    if (d.kind === 'BILL' && !d.reverseCharge && !d.gstin && inputTax.gt(0)) at('ITC_WITHOUT_SUPPLIER_GSTIN', `${name}: input tax credit of ${inputTax.toFixed(2)} needs the supplier's GSTIN on the bill; without it the credit cannot be claimed`, null, inputTax);
  }
  for (const [hsn, rates] of [...hsnRates].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (rates.size < 2) continue;
    const parts = [...rates].sort((a, b) => dec(a[0]).comparedTo(dec(b[0]))).map(([r, nums]) => `${r}% on ${[...new Set(nums)].slice(0, 3).join(', ')}${new Set(nums).size > 3 ? '…' : ''}`);
    out.push({ kind: 'HSN_RATE_VARIES', severity: 'LOW', documentId: null, documentKind: null, documentNumber: null, date: null, lineNo: null, amount: null, message: `HSN ${hsn} was sold at different rates: ${parts.join('; ')}. One code usually has one rate; check the rate or the code` });
  }
  const rank: Record<GstDiscrepancySeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }; // not money
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.date ?? '9999').localeCompare(b.date ?? '9999') || (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''));
}
