import { D, dec } from '@talk2tax/accounting-engine';
import { type GstCategory, hsnIssue, type SupplyNature } from './gst';
import { reverseChargeCategory } from './reverse-charge';
import { FOREIGN_PLACE_OF_SUPPLY, indiaState } from './states';
import { depositDueDate, TDS_TEMPLATES } from './withholding';

/**
 * Source-backed tax explanations (TAX-052). This module explains, in plain words, how the tax on
 * one posted document was worked out, and every statement names where it comes from:
 * - BOOKS: a fact recorded in Talk2Tax (the document, its contact, the tax rate and its versions,
 *   the GST registration);
 * - LAW: the provision that gives the rule.
 * Nothing is computed here that the document does not already hold: the figures are the posted
 * ones, and the explanation is built only from them and from fixed rules. No AI model is used, so
 * nothing is invented. Where the books cannot settle a point (blocked credits, the condition of a
 * reverse-charge entry), the explanation says so instead of guessing.
 */
export interface TaxSource {
  kind: 'LAW' | 'BOOKS';
  label: string;
}

export interface TaxExplanationPoint {
  key: string;
  title: string;
  text: string;
  sources: TaxSource[];
}

export interface TaxExplanationLine {
  lineNo: number;
  description: string;
  hsnCode: string | null;
  tax: string;
  text: string;
  sources: TaxSource[];
}

export interface TaxExplanationInputLine {
  lineNo: number;
  description: string;
  hsnCode: string | null;
  taxName: string | null;
  taxKind: 'GST' | 'SIMPLE' | null;
  gstCategory: GstCategory | null;
  /** The rate used on the line, percent. */
  taxRate: string;
  netAmount: string;
  cgst: string;
  sgst: string;
  igst: string;
  taxAmount: string;
  /** The tax rate record: its original rate, the rate in force on the document date, and since when. */
  rateRecord: { original: string; inForce: string; changedOn: string | null } | null;
}

export interface TaxExplanationInput {
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT';
  number: string | null;
  issueDate: string;
  currency: string;
  exchangeRate: string;
  functionalCurrency: string;
  contactName: string;
  gst: { placeOfSupply: string; supplierState: string | null; supplyNature: SupplyNature; counterpartyGstin: string | null; orgState: string | null } | null;
  reverseCharge: boolean;
  /** Set when the invoice is a debit note on an earlier invoice. */
  debitNoteFor: string | null;
  lines: TaxExplanationInputLine[];
  withholding: { kind: 'TDS' | 'TCS'; code: string; name: string; rate: string; subject: string; base: string; amount: string; pan: string | null } | null;
}

export interface TaxExplanation {
  summary: string;
  points: TaxExplanationPoint[];
  lines: TaxExplanationLine[];
  /** Things the books show that look wrong or that need checking. */
  checks: string[];
  basis: string;
}

const law = (label: string): TaxSource => ({ kind: 'LAW', label });
const books = (label: string): TaxSource => ({ kind: 'BOOKS', label });
const stateName = (code: string | null | undefined) => (!code ? 'unknown' : code === FOREIGN_PLACE_OF_SUPPLY ? 'outside India' : `${indiaState(code)?.name ?? code} (${code})`);
const zero = (v: string) => dec(v).isZero();
const KIND_LABEL = { INVOICE: 'invoice', CREDIT_NOTE: 'credit note', BILL: 'bill', VENDOR_CREDIT: 'vendor credit' } as const;

/** How the tax on a posted document was worked out, each point with its source. */
export function explainDocumentTax(d: TaxExplanationInput): TaxExplanation {
  const sales = d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE';
  const money = (v: string | InstanceType<typeof D>) => `${d.currency} ${dec(v.toString()).toFixed(2)}`;
  const points: TaxExplanationPoint[] = [];
  const checks: string[] = [];
  const g = d.gst;
  const what = d.debitNoteFor ? `debit note on ${d.debitNoteFor}` : KIND_LABEL[d.kind];
  const docRef = books(`${d.number ?? 'Draft'} (${what}), dated ${d.issueDate}`);

  if (g) {
    const export_ = g.placeOfSupply === FOREIGN_PLACE_OF_SUPPLY;
    points.push(
      sales
        ? {
            key: 'place_of_supply',
            title: 'Place of supply',
            text: export_
              ? `The place of supply is outside India, so this is an export: a zero-rated supply. It is recorded with payment of IGST, which can be claimed back as a refund.`
              : `The place of supply is ${stateName(g.placeOfSupply)}. For goods it is generally where the goods are delivered; for most services to a registered customer it is where the customer is located. It defaults to ${d.contactName}'s state and can be changed on the ${KIND_LABEL[d.kind]}.`,
            sources: export_ ? [law('IGST Act, 2017, s.16 (zero-rated supply) and s.16(3)(b) (refund of IGST paid)'), docRef] : [law('IGST Act, 2017, s.10 (goods) and s.12 (services)'), docRef],
          }
        : {
            key: 'place_of_supply',
            title: 'Place of supply',
            text: `The place of supply is ${stateName(g.placeOfSupply)}, where you receive the goods or services; ${d.contactName} supplies from ${stateName(g.supplierState)}.`,
            sources: [law(g.supplierState === FOREIGN_PLACE_OF_SUPPLY ? 'IGST Act, 2017, s.13 (services from outside India: where the recipient is)' : 'IGST Act, 2017, s.10 (goods) and s.12 (services)'), books(`${d.contactName}'s GSTIN or state`), docRef],
          },
    );
    const intra = g.supplyNature === 'INTRA';
    const levy = intra ? (indiaState(g.placeOfSupply)?.levies ?? 'SGST') : null;
    points.push({
      key: 'nature',
      title: intra ? `Intra-state: CGST and ${levy}` : 'Inter-state: IGST',
      text: intra
        ? `The supplier is in the same state as the place of supply, so the supply is intra-state: half the rate is CGST and half is ${levy}${levy === 'UTGST' ? ' (a Union territory without a legislature)' : ''}.`
        : `The supplier's state (${stateName(g.supplierState)}) differs from the place of supply${export_ ? ', which is outside India' : ''}, so the supply is inter-state and the whole rate is IGST.`,
      sources: intra ? [law('IGST Act, 2017, s.8 (intra-state supply)'), law(levy === 'UTGST' ? 'CGST Act, 2017, s.9(1) and UTGST Act, 2017, s.7' : 'CGST Act, 2017, s.9(1) and the state GST Act')] : [law('IGST Act, 2017, s.7 (inter-state supply) and s.5(1)')],
    });
    if (d.reverseCharge) {
      const imported = g.supplierState === FOREIGN_PLACE_OF_SUPPLY;
      const cats = [...new Set(d.lines.map((l) => reverseChargeCategory(l.hsnCode)?.title).filter((x): x is string => !!x))];
      points.push({
        key: 'reverse_charge',
        title: 'Reverse charge',
        text: `You, not ${d.contactName}, pay the GST on this ${KIND_LABEL[d.kind]}${imported ? ' because it is an import of services' : cats.length ? ` because it is ${cats.join(', ').toLowerCase()}, a notified category` : ''}. The supplier does not charge it; it is owed to the government, paid in cash (not from input tax credit), and can then be claimed back as input tax credit.${!g.counterpartyGstin && d.kind === 'BILL' ? ' As the supplier is not registered, you issue a self-invoice within 30 days.' : ''}`,
        sources: [
          law(imported ? 'IGST Act, 2017, s.5(3) and Notification 10/2017-Integrated Tax (Rate), entry 1' : 'CGST Act, 2017, s.9(3); Notifications 13/2017 and 4/2017-Central Tax (Rate)'),
          law('CGST Act, 2017, s.49(4) (paid in cash)'),
          ...(!g.counterpartyGstin && d.kind === 'BILL' ? [law('CGST Act, 2017, s.31(3)(f) and CGST Rules, rule 47A (self-invoice)')] : []),
          books('Reverse charge ticked on the document'),
        ],
      });
      if (!imported && !cats.length) checks.push('Reverse charge is ticked, but no line has an HSN/SAC in the notified list. Check that the supply is one on which you pay the tax.');
    } else if (!sales) {
      const charged = d.lines.some((l) => !zero(l.cgst) || !zero(l.sgst) || !zero(l.igst));
      if (charged) {
        points.push({
          key: 'input_credit',
          title: 'Input tax credit',
          text: `The GST ${d.contactName} charged is recorded as input tax credit. You can claim it when you hold the tax invoice, have received the goods or services, the supplier has filed the return and paid the tax, and it shows in your GSTR-2B. Credit on some purchases (for example food, motor vehicles, personal use) is blocked; the books cannot tell, so check them.`,
          sources: [law('CGST Act, 2017, s.16(2) (conditions)'), law('CGST Act, 2017, s.17(5) (blocked credits)'), books(g.counterpartyGstin ? `Supplier's GSTIN ${g.counterpartyGstin}` : 'No supplier GSTIN on the document')],
        });
        if (!g.counterpartyGstin) checks.push(`${d.contactName} has no GSTIN on this ${KIND_LABEL[d.kind]}, so the credit cannot be claimed.`);
      }
    }
    if (d.kind === 'CREDIT_NOTE' || d.kind === 'VENDOR_CREDIT' || d.debitNoteFor) {
      points.push({
        key: 'note',
        title: d.debitNoteFor ? 'Debit note' : 'Credit note',
        text: d.debitNoteFor
          ? `This raises the value of ${d.debitNoteFor}, and the tax on it is added to the tax on that invoice.`
          : `This reduces the value of earlier ${sales ? 'invoices' : 'bills'}, and the tax on it reduces ${sales ? 'the tax you owe' : 'your input tax credit'} for the month it is issued.`,
        sources: [law(d.debitNoteFor ? 'CGST Act, 2017, s.34(3)' : 'CGST Act, 2017, s.34(1)')],
      });
    }
  }

  if (d.currency !== d.functionalCurrency) {
    points.push({
      key: 'currency',
      title: 'Foreign currency',
      text: `The document is in ${d.currency}. For the books and the GST returns its values are converted to ${d.functionalCurrency} at ${d.exchangeRate}, the rate recorded on the document.`,
      sources: [books(`Exchange rate ${d.exchangeRate} on the document`), ...(g ? [law('CGST Rules, rule 34 (rate of exchange for the value of supply)')] : [])],
    });
  }

  const lines: TaxExplanationLine[] = d.lines.map((l) => {
    const sources: TaxSource[] = [];
    let text: string;
    const net = money(l.netAmount);
    const tax = dec(l.cgst).plus(dec(l.sgst)).plus(dec(l.igst));
    const lineTax = l.taxKind === 'GST' ? tax : dec(l.taxAmount);
    if (!l.taxName) {
      text = `No tax rate on this line, so no tax.`;
    } else if (l.taxKind === 'GST' && g) {
      sources.push(books(`Tax rate "${l.taxName}"`));
      const cat = l.gstCategory ?? 'NON_GST';
      if (cat === 'NIL_RATED') {
        text = `${net} is nil-rated: GST applies at 0%. It is reported separately in the returns.`;
        sources.push(law('GSTR-1 table 8 and GSTR-3B table 3.1(c)'));
      } else if (cat === 'EXEMPT') {
        text = `${net} is exempt from GST by notification. It is reported separately in the returns${sales ? '' : ', and no input tax credit arises'}.`;
        sources.push(law('CGST Act, 2017, s.11; Notifications 2/2017 (goods) and 12/2017 (services)-Central Tax (Rate)'));
      } else if (cat === 'NON_GST') {
        text = `${net} is outside GST (for example petroleum crude, petrol, diesel, natural gas, aviation turbine fuel, or alcoholic liquor for human consumption).`;
        sources.push(law('CGST Act, 2017, s.9(1) and s.9(2)'));
      } else if (g.supplyNature === 'INTER') {
        text = `${net} at ${l.taxRate}% = IGST ${money(l.igst)}${d.reverseCharge ? ', paid by you under reverse charge' : ''}.`;
        sources.push(law('IGST Act, 2017, s.5(1)'));
      } else {
        const half = dec(l.taxRate).dividedBy(2).toFixed();
        const levy = indiaState(g.placeOfSupply)?.levies ?? 'SGST';
        text = `${net} at ${l.taxRate}% = CGST ${half}% ${money(l.cgst)} and ${levy} ${half}% ${money(l.sgst)}, each rounded on its own so the halves are equal${d.reverseCharge ? ', paid by you under reverse charge' : ''}.`;
        sources.push(law(`CGST Act, 2017, s.9(1) and ${levy === 'UTGST' ? 'UTGST Act, 2017, s.7' : 'the state GST Act'}`));
      }
      if (cat === 'TAXABLE') {
        const h = hsnIssue(l.hsnCode);
        if (h) checks.push(`Line ${l.lineNo}: ${h}; the HSN/SAC is needed on the tax invoice and in GSTR-1.`);
        else sources.push(books(`HSN/SAC ${l.hsnCode}`), law('CGST Rules, rule 46(g) (HSN on the tax invoice)'));
      }
    } else {
      text = `${net} at ${l.taxRate}% = ${money(l.taxAmount)} (${l.taxName}).`;
      sources.push(books(`Tax rate "${l.taxName}"`));
    }
    if (l.rateRecord && l.taxName) {
      if (l.rateRecord.changedOn) {
        text += ` "${l.taxName}" was ${l.rateRecord.original}% when it was set up; ${l.rateRecord.inForce}% has been in force since ${l.rateRecord.changedOn}, which covers ${d.issueDate}.`;
        sources.push(books(`Rate versions of "${l.taxName}"`));
      }
      if (!dec(l.rateRecord.inForce).eq(dec(l.taxRate))) checks.push(`Line ${l.lineNo} uses ${l.taxRate}%, but "${l.taxName}" was ${l.rateRecord.inForce}% on ${d.issueDate}.`);
    }
    return { lineNo: l.lineNo, description: l.description, hsnCode: l.hsnCode, tax: lineTax.toFixed(2), text, sources };
  });

  const w = d.withholding;
  if (w) {
    const tpl = TDS_TEMPLATES.find((t) => t.code === w.code);
    const tds = w.kind === 'TDS';
    const caught = !dec(w.base).eq(dec(w.subject));
    points.push({
      key: 'withholding',
      title: tds ? 'TDS' : 'TCS',
      text: `${tds ? `You deduct ${money(w.amount)} of income tax from what you pay ${d.contactName}` : `You collect ${money(w.amount)} of income tax from ${d.contactName} on top of the invoice`}: ${w.rate}% on ${money(w.base)} under section ${w.code} (${w.name}).${caught ? ` The base is more than this ${KIND_LABEL[d.kind]} (${money(w.subject)}) because, with it, payments to ${d.contactName} crossed the yearly threshold, so earlier ones below it are taxed now.` : ''}${w.pan ? '' : ' There is no PAN on file, so the higher no-PAN rate applies if it is higher.'} It is due to the government by ${depositDueDate(d.issueDate)} (the 7th of the next month; 30 April for March), counted from this date.`,
      sources: [tpl ? law(tpl.source) : books(`Section ${w.code} as set up in TDS/TCS settings`), books(w.pan ? `PAN ${w.pan}` : 'No PAN on the contact')],
    });
  }

  const gstTotal = d.lines.reduce((s, l) => s.plus(dec(l.cgst)).plus(dec(l.sgst)).plus(dec(l.igst)), new D(0));
  const otherTotal = d.lines.filter((l) => l.taxKind !== 'GST').reduce((s, l) => s.plus(dec(l.taxAmount)), new D(0));
  const parts = [
    ...(g ? [`GST ${money(gstTotal)}${d.reverseCharge ? ' payable by you under reverse charge' : ''}`] : []),
    ...(!otherTotal.isZero() ? [`other tax ${money(otherTotal)}`] : []),
    ...(w ? [`${w.kind} ${money(w.amount)}`] : []),
  ];
  const summary = parts.length ? `Tax on this ${what}: ${parts.join('; ')}.` : `No tax on this ${what}.`;
  return { summary, points, lines, checks, basis: 'Built from the posted document and fixed rules. Every figure is the one on the document; no AI model is used.' };
}
