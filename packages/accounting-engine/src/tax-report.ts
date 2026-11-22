/**
 * Tax reports (RPT-009): the tax in a period from the posted documents and the tax accounts in
 * the ledger, in the functional currency.
 *
 * - By rate: taxable value and tax on sales (invoices less credit notes) and on purchases (bills
 *   less vendor credits), each line converted at its document's exchange rate; GST heads (CGST,
 *   SGST, IGST) where the line carries them. Output tax less input tax is the net. Tax a buyer
 *   pays under reverse charge is shown on its own; it is both owed and, usually, claimed.
 * - By month: output tax, input tax and net, by document date.
 * - Withholding: TDS on bills and TCS on invoices by section, with the base and the amount.
 * - Tax accounts: each tax payable, tax receivable and tax expense account with its balance at
 *   the start, debits and credits in the period and the balance at the end (debit positive).
 */
import { D, type Dec, dec, roundToCurrency, minorUnits } from './money';

export type TaxReportKind = 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT';

export interface TaxReportDocument {
  kind: TaxReportKind;
  issueDate: string;
  exchangeRate: string;
  reverseChargeTax: string;
  withholding: { kind: 'TDS' | 'TCS'; section: string; base: string; amount: string } | null;
  lines: { taxRate: string; netAmount: string; taxAmount: string; cgstAmount: string; sgstAmount: string; igstAmount: string }[];
}

export interface TaxAccountMovement {
  code: string;
  name: string;
  subtype: string;
  opening: string;
  debit: string;
  credit: string;
}

interface Side {
  taxable: Dec;
  tax: Dec;
  cgst: Dec;
  sgst: Dec;
  igst: Dec;
}
const side = (): Side => ({ taxable: new D(0), tax: new D(0), cgst: new D(0), sgst: new D(0), igst: new D(0) });

export function buildTaxReport(documents: readonly TaxReportDocument[], accounts: readonly TaxAccountMovement[], currency: string) {
  const m = minorUnits(currency);
  const show = (v: Dec) => roundToCurrency(v, currency).toFixed(m);
  const rates = new Map<string, { sales: Side; purchases: Side }>();
  const months = new Map<string, { output: Dec; input: Dec }>();
  const withholding = new Map<string, { kind: 'TDS' | 'TCS'; section: string; base: Dec; amount: Dec; documents: number }>();
  const total = { sales: side(), purchases: side() };
  let reverseCharge = new D(0);
  let documentsCounted = 0;

  for (const d of documents) {
    documentsCounted += 1;
    const sales = d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE';
    const sign = d.kind === 'CREDIT_NOTE' || d.kind === 'VENDOR_CREDIT' ? -1 : 1;
    const fx = dec(d.exchangeRate);
    const conv = (x: string) => roundToCurrency(dec(x).times(fx), currency).times(sign);
    const month = d.issueDate.slice(0, 7);
    const mo = months.get(month) ?? { output: new D(0), input: new D(0) };
    for (const l of d.lines) {
      const rate = dec(l.taxRate).toFixed();
      const r = rates.get(rate) ?? { sales: side(), purchases: side() };
      const into = [sales ? r.sales : r.purchases, sales ? total.sales : total.purchases];
      for (const s of into) {
        s.taxable = s.taxable.plus(conv(l.netAmount));
        s.tax = s.tax.plus(conv(l.taxAmount));
        s.cgst = s.cgst.plus(conv(l.cgstAmount));
        s.sgst = s.sgst.plus(conv(l.sgstAmount));
        s.igst = s.igst.plus(conv(l.igstAmount));
      }
      if (sales) mo.output = mo.output.plus(conv(l.taxAmount));
      else mo.input = mo.input.plus(conv(l.taxAmount));
      rates.set(rate, r);
    }
    months.set(month, mo);
    if (!sales) reverseCharge = reverseCharge.plus(conv(d.reverseChargeTax));
    if (d.withholding && !dec(d.withholding.amount).isZero()) {
      const key = `${d.withholding.kind}|${d.withholding.section}`;
      const w = withholding.get(key) ?? { kind: d.withholding.kind, section: d.withholding.section, base: new D(0), amount: new D(0), documents: 0 };
      w.base = w.base.plus(conv(d.withholding.base));
      w.amount = w.amount.plus(conv(d.withholding.amount));
      w.documents += 1;
      withholding.set(key, w);
    }
  }

  const showSide = (s: Side) => ({ taxable: show(s.taxable), tax: show(s.tax), cgst: show(s.cgst), sgst: show(s.sgst), igst: show(s.igst) });
  const accountRows = accounts.map((a) => {
    const closing = dec(a.opening).plus(dec(a.debit)).minus(dec(a.credit));
    return { code: a.code, name: a.name, subtype: a.subtype, opening: show(dec(a.opening)), debit: show(dec(a.debit)), credit: show(dec(a.credit)), closing: show(closing) };
  });
  return {
    documents: documentsCounted,
    totals: {
      sales: showSide(total.sales),
      purchases: showSide(total.purchases),
      outputTax: show(total.sales.tax),
      inputTax: show(total.purchases.tax),
      net: show(total.sales.tax.minus(total.purchases.tax)),
      reverseCharge: show(reverseCharge),
      tds: show([...withholding.values()].filter((w) => w.kind === 'TDS').reduce((s, w) => s.plus(w.amount), new D(0))),
      tcs: show([...withholding.values()].filter((w) => w.kind === 'TCS').reduce((s, w) => s.plus(w.amount), new D(0))),
    },
    byRate: [...rates.entries()]
      .sort((a, b) => dec(a[0]).comparedTo(dec(b[0])))
      .map(([rate, r]) => ({ rate, sales: showSide(r.sales), purchases: showSide(r.purchases), net: show(r.sales.tax.minus(r.purchases.tax)) })),
    byMonth: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, x]) => ({ month, outputTax: show(x.output), inputTax: show(x.input), net: show(x.output.minus(x.input)) })),
    withholding: [...withholding.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.section.localeCompare(b.section)).map((w) => ({ kind: w.kind, section: w.section, base: show(w.base), amount: show(w.amount), documents: w.documents })),
    accounts: accountRows,
  };
}

export type TaxReport = ReturnType<typeof buildTaxReport>;

/** The report as CSV: one block per table, with formula-like text guarded. */
export function taxReportCsv(r: TaxReport, period: { from: string; to: string; currency: string }): string {
  const risky = (v: string) => /^[=+@]/.test(v) || /^-(?!\d)/.test(v);
  const q = (v: string) => {
    const t = risky(v) ? `'${v}` : v;
    return risky(v) || /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const out: string[] = [];
  const row = (...cells: string[]) => out.push(cells.map(q).join(','));
  row('Tax report', `${period.from} to ${period.to}`, period.currency);
  row('');
  row('Rate %', 'Sales taxable', 'Output tax', 'Purchases taxable', 'Input tax', 'Net');
  for (const x of r.byRate) row(x.rate, x.sales.taxable, x.sales.tax, x.purchases.taxable, x.purchases.tax, x.net);
  row('Total', r.totals.sales.taxable, r.totals.outputTax, r.totals.purchases.taxable, r.totals.inputTax, r.totals.net);
  row('');
  row('Month', 'Output tax', 'Input tax', 'Net');
  for (const x of r.byMonth) row(x.month, x.outputTax, x.inputTax, x.net);
  row('');
  row('Withholding', 'Section', 'Base', 'Amount', 'Documents');
  for (const x of r.withholding) row(x.kind, x.section, x.base, x.amount, String(x.documents));
  row('');
  row('Account', 'Name', 'Opening', 'Debits', 'Credits', 'Closing');
  for (const x of r.accounts) row(x.code, x.name, x.opening, x.debit, x.credit, x.closing);
  return `${out.join('\n')}\n`;
}
