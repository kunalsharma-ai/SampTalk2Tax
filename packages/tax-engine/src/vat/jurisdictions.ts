import { D } from '@talk2tax/accounting-engine';
import { CA_GST_TREATMENTS, CA_ITC_MONTHS, CA_RETURN_LABEL, CA_TREATMENT_LABEL, caCorrectionAllowance, caGstHstDueDate, caGstHstPeriodFor, caGstHstReturn, normaliseCaBusinessNumber, recentCaGstHstPeriods, suggestCaTreatment } from '../ca/gst-hst';
import { AU_BAS_LABEL, AU_GST_TREATMENTS, AU_STAGGERS, AU_TREATMENT_LABEL, auBasDueDate, auBasPeriodFor, auCorrectionAllowance, auGstBas, normaliseAbn, recentAuBasPeriods, suggestAuTreatment } from '../au/gst-bas';
import { recentSgGstPeriods, normaliseSgGstNumber, SG_F5_BOX_LABEL, SG_GST_TREATMENTS, SG_TREATMENT_LABEL, sgCorrectionAllowance, sgGstDueDate, sgGstPeriodFor, sgGstReturn, suggestSgTreatment } from '../sg/gst-f5';
import {
  normaliseVrn,
  recentVatPeriods,
  suggestVatTreatment,
  ukVatReturn,
  VAT_BOX_LABEL,
  VAT_TREATMENT_LABEL,
  VAT_STAGGERS,
  VAT_TREATMENTS,
  vatCorrectionAllowance,
  vatDueDate,
  vatPeriodFor,
  type VatEntry,
  type VatRateInfo,
  type VatStagger,
  type VatTreatment,
} from '../uk/vat-return';

/**
 * Countries whose VAT or GST return Talk2Tax prepares (TAX-041: supported jurisdictions added one
 * at a time): the United Kingdom (TAX-030), Singapore (TAX-036), Australia (TAX-035, the GST on the BAS)
 * and Canada (TAX-034, the GST/HST return). Each says what its return is
 * called, its registration number, the treatments it has, its periods and due dates, its boxes,
 * how to work them out and how much of an earlier error may be corrected on the next return.
 * Output and input tax are the common figures: changes to submitted periods are found from them.
 */
export interface TaxReturnFigures {
  boxes: Record<string, string>;
  direction: 'PAY' | 'RECLAIM' | 'NIL';
  /** The period's own figures before corrections, kept with a submitted return. */
  own: { output: string; input: string; supplies: string; purchases: string };
  breakdown: { side: 'SALES' | 'PURCHASES'; treatment: VatTreatment; label: string; net: string; vat: string; lines: number; counted: boolean }[];
  unclassified: { id: string; name: string; rate: string; lines: number }[];
  issues: string[];
  warnings: string[];
}

export interface TaxReturnCorrection {
  periodEnd: string;
  output: string;
  input: string;
}

export interface VatJurisdiction {
  country: string;
  /** As it reads in a sentence: the United Kingdom, Singapore, Australia. */
  countryName: string;
  currency: string;
  /** VAT or GST. */
  taxName: string;
  returnName: string;
  authority: string;
  /** The authority as it reads inside a sentence: HMRC, IRAS, the ATO. */
  authorityThe: string;
  /** How the boxes' amounts are given. */
  unitsNote: string;
  numberName: string;
  /** The number as a short label: VAT number, GST number, ABN. */
  numberShort: string;
  numberHint: string;
  normaliseNumber(input: string): string | null;
  invalidNumber: string;
  treatments: readonly VatTreatment[];
  treatmentLabel: Record<VatTreatment, string>;
  suggest(rate: string, name: string): VatTreatment | null;
  periodFor(stagger: VatStagger, end: string): { start: string; end: string; due: string } | null;
  recentPeriods(stagger: VatStagger, today: string, count: number): { start: string; end: string; due: string }[];
  /** The return cycles the authority uses. */
  staggers: readonly VatStagger[];
  dueDate(end: string, stagger: VatStagger): string;
  dueRule: string;
  boxLabels: Record<string, string>;
  /** The box with the net tax to pay or reclaim. */
  netBox: string;
  outputBox: string;
  inputBox: string;
  /** Boxes in whole units (pence or cents left off). */
  wholeBoxes: readonly string[];
  /** Box 13 of the Singapore F5: revenue from the ledger. */
  needsRevenue: boolean;
  compute(entries: readonly VatEntry[], rates: readonly VatRateInfo[], opts: { untaxed: VatTreatment; revenue: string; corrections: readonly TaxReturnCorrection[] }): TaxReturnFigures;
  correctionAllowance(corrections: readonly TaxReturnCorrection[], own: TaxReturnFigures['own']): { net: string; limit: string; allowed: boolean };
  /** What to do when the corrections are over the limit. */
  overLimit: string;
  /** Where the rule is not an amount: which changes to earlier returns may go on a later one. */
  correctionRule?: string;
  /** How far back a submitted period's changes may still be corrected on a later return. */
  correctionMonths: number;
  /** What the return covers and where the business files it. */
  intro: string;
  /** How each treatment counts on the return. */
  treatmentNote: string;
  /** The page's card titles, each unique so its help can say what this country's return does. */
  cardTitles: { registration: string; periods: string; boxes: string; treatment: string; other: string };
}

const UK: VatJurisdiction = {
  country: 'GB',
  countryName: 'the United Kingdom',
  currency: 'GBP',
  taxName: 'VAT',
  returnName: 'VAT return',
  authority: 'HMRC',
  authorityThe: 'HMRC',
  unitsNote: 'Boxes 1 to 5 in pounds and pence; boxes 6 to 9 in whole pounds.',
  numberName: 'VAT registration number',
  numberShort: 'VAT number',
  numberHint: '9 digits, with or without GB',
  normaliseNumber: normaliseVrn,
  invalidNumber: 'That is not a valid UK VAT registration number (9 digits, or 12 for a branch)',
  treatments: VAT_TREATMENTS,
  treatmentLabel: VAT_TREATMENT_LABEL,
  suggest: suggestVatTreatment,
  periodFor: vatPeriodFor,
  recentPeriods: recentVatPeriods,
  staggers: VAT_STAGGERS,
  dueDate: vatDueDate,
  dueRule: 'A return and payment are due one calendar month and seven days after the period ends.',
  boxLabels: VAT_BOX_LABEL,
  netBox: 'box5',
  outputBox: 'box1',
  inputBox: 'box4',
  wholeBoxes: ['box6', 'box7', 'box8', 'box9'],
  needsRevenue: false,
  compute(entries, rates, opts) {
    const r = ukVatReturn(entries, rates, { untaxed: opts.untaxed, corrections: opts.corrections.map((c) => ({ periodEnd: c.periodEnd, box1: c.output, box4: c.input })) });
    return { ...r, boxes: { ...r.boxes }, own: { output: r.own.box1, input: r.own.box4, supplies: r.own.box6, purchases: r.own.box7 } };
  },
  correctionAllowance: (corrections, own) => vatCorrectionAllowance(corrections.map((c) => ({ box1: c.output, box4: c.input })), own.supplies),
  overLimit: 'tell HMRC about them separately (form VAT652)',
  correctionMonths: 48,
  intro: "The nine boxes of your UK VAT return for each VAT period, prepared from posted invoices, credit notes, bills, vendor credits and approved expense claims on the invoice basis. Enter them in your Making Tax Digital software or HMRC's service, then record the submission here; nothing is sent to HMRC from Talk2Tax.",
  treatmentNote: 'Sales and purchases in the period by how their tax rate counts. Exempt supplies count in boxes 6 and 7 without VAT; supplies outside the scope of VAT are not on the return.',
  cardTitles: { registration: 'VAT registration', periods: 'VAT periods', boxes: 'VAT return boxes', treatment: 'Figures by VAT treatment', other: 'Other entries on the VAT accounts' },
};

const SG: VatJurisdiction = {
  country: 'SG',
  countryName: 'Singapore',
  currency: 'SGD',
  taxName: 'GST',
  returnName: 'GST return (F5)',
  authority: 'IRAS',
  authorityThe: 'IRAS',
  unitsNote: 'Amounts in Singapore dollars.',
  numberName: 'GST registration number',
  numberShort: 'GST number',
  numberHint: 'Your UEN or M-number, such as 201912345K',
  normaliseNumber: normaliseSgGstNumber,
  invalidNumber: 'That is not a Singapore GST registration number (a UEN such as 201912345K, or an M-number such as M90312345A)',
  treatments: SG_GST_TREATMENTS,
  treatmentLabel: SG_TREATMENT_LABEL,
  suggest: suggestSgTreatment,
  periodFor: sgGstPeriodFor,
  recentPeriods: recentSgGstPeriods,
  staggers: VAT_STAGGERS,
  dueDate: sgGstDueDate,
  dueRule: 'A return and payment are due one month after the period ends.',
  boxLabels: SG_F5_BOX_LABEL,
  netBox: 'box8',
  outputBox: 'box6',
  inputBox: 'box7',
  wholeBoxes: [],
  needsRevenue: true,
  compute: (entries, rates, opts) => sgGstReturn(entries, rates, opts),
  correctionAllowance: (corrections) => sgCorrectionAllowance(corrections),
  overLimit: 'correct the earlier returns with IRAS instead (GST F7)',
  correctionMonths: 60,
  intro: 'The boxes of your GST return (F5) for each accounting period, prepared from posted invoices, credit notes, bills, vendor credits and approved expense claims, with revenue from the ledger. Enter them in myTax Portal, then record the submission here; nothing is sent to IRAS from Talk2Tax.',
  treatmentNote: 'Supplies and purchases in the period by how their tax rate counts. Exempt supplies count in box 3; exempt and out-of-scope purchases and out-of-scope supplies are not on the return.',
  cardTitles: { registration: 'GST registration', periods: 'GST periods', boxes: 'GST return boxes', treatment: 'Figures by GST treatment', other: 'Other entries on the GST accounts' },
};

const AU: VatJurisdiction = {
  country: 'AU',
  countryName: 'Australia',
  currency: 'AUD',
  taxName: 'GST',
  returnName: 'Business activity statement (GST)',
  authority: 'ATO',
  authorityThe: 'the ATO',
  unitsNote: 'In whole dollars, cents left off.',
  numberName: 'ABN',
  numberShort: 'ABN',
  numberHint: '11 digits, such as 51 824 753 556',
  normaliseNumber: normaliseAbn,
  invalidNumber: 'That is not a valid Australian Business Number (11 digits that pass the ATO check)',
  treatments: AU_GST_TREATMENTS,
  treatmentLabel: AU_TREATMENT_LABEL,
  suggest: suggestAuTreatment,
  periodFor: auBasPeriodFor,
  recentPeriods: recentAuBasPeriods,
  staggers: AU_STAGGERS,
  dueDate: (end, stagger) => auBasDueDate(end, stagger === 'MONTHLY'),
  dueRule: 'A monthly BAS is due on the 21st of the next month; a quarterly BAS on the 28th of the month after the quarter, and the October to December quarter on 28 February.',
  boxLabels: AU_BAS_LABEL,
  netBox: 'net',
  outputBox: '1A',
  inputBox: '1B',
  wholeBoxes: ['G1', '1A', '1B', 'net'],
  needsRevenue: false,
  compute: (entries, rates, opts) => auGstBas(entries, rates, { untaxed: opts.untaxed, corrections: opts.corrections }),
  correctionAllowance: (corrections) => auCorrectionAllowance(corrections),
  overLimit: 'revise the earlier BAS with the ATO instead',
  correctionMonths: 18,
  intro: 'The GST items of your business activity statement (G1, 1A and 1B on Simpler BAS) for each tax period, prepared from posted invoices, credit notes, bills, vendor credits and approved expense claims on the accruals basis, in whole dollars. Enter them in ATO Online services or Online services for business, then record the lodgment here; nothing is sent to the ATO from Talk2Tax.',
  treatmentNote: 'Sales and purchases in the period by how their tax rate counts. GST-free and input-taxed sales count in G1 without GST; only taxable purchases give GST credits at 1B; out-of-scope lines are not on the BAS.',
  cardTitles: { registration: 'ABN and BAS cycle', periods: 'BAS periods', boxes: 'BAS GST items', treatment: 'Sales and purchases by GST treatment', other: 'Other entries on the GST accounts (BAS)' },
};

const CA: VatJurisdiction = {
  country: 'CA',
  countryName: 'Canada',
  currency: 'CAD',
  taxName: 'GST/HST',
  returnName: 'GST/HST return',
  authority: 'CRA',
  authorityThe: 'the CRA',
  unitsNote: 'Line 101 in whole dollars; the other lines in dollars and cents.',
  numberName: 'Business number (GST/HST account)',
  numberShort: 'BN',
  numberHint: '9 digits, RT and 4 digits, such as 123456782 RT0001',
  normaliseNumber: normaliseCaBusinessNumber,
  invalidNumber: 'That is not a valid business number with a GST/HST account (9 digits that pass the check, then RT and 4 digits)',
  treatments: CA_GST_TREATMENTS,
  treatmentLabel: CA_TREATMENT_LABEL,
  suggest: suggestCaTreatment,
  periodFor: caGstHstPeriodFor,
  recentPeriods: recentCaGstHstPeriods,
  staggers: VAT_STAGGERS,
  dueDate: (end) => caGstHstDueDate(end),
  dueRule: 'A monthly or quarterly return and payment are due one month after the reporting period ends.',
  boxLabels: CA_RETURN_LABEL,
  netBox: '109',
  outputBox: '105',
  inputBox: '108',
  wholeBoxes: ['101'],
  needsRevenue: true,
  compute: (entries, rates, opts) => caGstHstReturn(entries, rates, { untaxed: opts.untaxed, revenue: opts.revenue, corrections: opts.corrections }),
  correctionAllowance: (corrections) => caCorrectionAllowance(corrections),
  overLimit: 'ask the CRA to adjust the earlier returns instead',
  correctionRule: 'only input tax credits missed on an earlier return may be claimed on a later one (within four years); GST/HST reported wrongly, or ITCs over-claimed, are corrected on the earlier return',
  correctionMonths: CA_ITC_MONTHS,
  intro: 'Lines 101 and 103 to 109 of your GST/HST return for each reporting period (regular method), prepared from posted invoices, credit notes, bills, vendor credits and approved expense claims, with revenue from the ledger. Enter them in My Business Account or GST/HST NETFILE, then record the filing here; nothing is sent to the CRA from Talk2Tax.',
  treatmentNote: 'Sales and purchases in the period by how their tax rate counts. Zero-rated and exempt sales are in the revenue on line 101 without GST/HST; only taxable purchases give input tax credits at line 106; out-of-scope lines are not on the return.',
  cardTitles: { registration: 'GST/HST registration', periods: 'GST/HST reporting periods', boxes: 'GST/HST return lines', treatment: 'Figures by GST/HST treatment', other: 'Other entries on the GST/HST accounts' },
};

export const VAT_JURISDICTIONS: readonly VatJurisdiction[] = [UK, SG, AU, CA];

/** The country's VAT or GST return, or null where Talk2Tax prepares none (India has its own GST returns). */
export function vatJurisdiction(country: string): VatJurisdiction | null {
  return VAT_JURISDICTIONS.find((j) => j.country === country) ?? null;
}

/** A change to a submitted period's output and input tax since it was submitted, less corrections already made. */
export function taxPeriodChange(filed: { output: string; input: string }, now: { output: string; input: string }, done: readonly { output: string; input: string }[]) {
  const output = done.reduce((a, c) => a.minus(c.output), new D(now.output).minus(filed.output));
  const input = done.reduce((a, c) => a.minus(c.input), new D(now.input).minus(filed.input));
  return { output: output.toFixed(2), input: input.toFixed(2), net: output.minus(input).toFixed(2), changed: !output.isZero() || !input.isZero() };
}
