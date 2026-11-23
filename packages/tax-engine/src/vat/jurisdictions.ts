import { D } from '@talk2tax/accounting-engine';
import { recentSgGstPeriods, normaliseSgGstNumber, SG_F5_BOX_LABEL, SG_GST_TREATMENTS, SG_TREATMENT_LABEL, sgCorrectionAllowance, sgGstDueDate, sgGstPeriodFor, sgGstReturn, suggestSgTreatment } from '../sg/gst-f5';
import {
  normaliseVrn,
  recentVatPeriods,
  suggestVatTreatment,
  ukVatReturn,
  VAT_BOX_LABEL,
  VAT_TREATMENT_LABEL,
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
 * at a time): the United Kingdom (TAX-030) and Singapore (TAX-036). Each says what its return is
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
  currency: string;
  /** VAT or GST. */
  taxName: string;
  returnName: string;
  authority: string;
  numberName: string;
  numberHint: string;
  normaliseNumber(input: string): string | null;
  invalidNumber: string;
  treatments: readonly VatTreatment[];
  treatmentLabel: Record<VatTreatment, string>;
  suggest(rate: string, name: string): VatTreatment | null;
  periodFor(stagger: VatStagger, end: string): { start: string; end: string; due: string } | null;
  recentPeriods(stagger: VatStagger, today: string, count: number): { start: string; end: string; due: string }[];
  dueDate(end: string): string;
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
  correctionYears: number;
}

const UK: VatJurisdiction = {
  country: 'GB',
  currency: 'GBP',
  taxName: 'VAT',
  returnName: 'VAT return',
  authority: 'HMRC',
  numberName: 'VAT registration number',
  numberHint: '9 digits, with or without GB',
  normaliseNumber: normaliseVrn,
  invalidNumber: 'That is not a valid UK VAT registration number (9 digits, or 12 for a branch)',
  treatments: VAT_TREATMENTS,
  treatmentLabel: VAT_TREATMENT_LABEL,
  suggest: suggestVatTreatment,
  periodFor: vatPeriodFor,
  recentPeriods: recentVatPeriods,
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
  correctionYears: 4,
};

const SG: VatJurisdiction = {
  country: 'SG',
  currency: 'SGD',
  taxName: 'GST',
  returnName: 'GST return (F5)',
  authority: 'IRAS',
  numberName: 'GST registration number',
  numberHint: 'Your UEN or M-number, such as 201912345K',
  normaliseNumber: normaliseSgGstNumber,
  invalidNumber: 'That is not a Singapore GST registration number (a UEN such as 201912345K, or an M-number such as M90312345A)',
  treatments: SG_GST_TREATMENTS,
  treatmentLabel: SG_TREATMENT_LABEL,
  suggest: suggestSgTreatment,
  periodFor: sgGstPeriodFor,
  recentPeriods: recentSgGstPeriods,
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
  correctionYears: 5,
};

export const VAT_JURISDICTIONS: readonly VatJurisdiction[] = [UK, SG];

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
