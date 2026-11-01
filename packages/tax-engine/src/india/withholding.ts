import { D, Dec, dec, roundToCurrency } from '@talk2tax/accounting-engine';

/**
 * India income-tax withholding: TDS (tax deducted at source by the payer) and
 * TCS (tax collected at source by the seller).
 *
 * Sections are configured by each organisation, because rates and thresholds
 * change with each Finance Act. The templates below are taken from the table in
 * s.393(1) of the Income-tax Act 2025 (in force for tax years from 1 April 2026),
 * as published at incometaxindia.gov.in. There are no TCS templates: TCS items
 * are entered by the organisation itself.
 *
 * What this module does not decide: whether the payer is a "specified" or
 * "designated" person under the Act (it assumes the organisation must deduct),
 * lower or nil deduction certificates, and nil-deduction declarations.
 */

export const WITHHOLDING_KINDS = ['TDS', 'TCS'] as const;
export type WithholdingKind = (typeof WITHHOLDING_KINDS)[number];

/** What a threshold is measured over: the tax year (April to March) or the calendar month. */
export type ThresholdWindow = 'TAX_YEAR' | 'MONTH';
/** WHOLE: once over the threshold, tax applies to the whole amount. EXCESS: only to the part above it. */
export type ThresholdBasis = 'WHOLE' | 'EXCESS';

export interface WithholdingRule {
  kind: WithholdingKind;
  code: string;
  name: string;
  /** Percent, decimal string. */
  rate: string;
  /** A different rate when the counterparty's PAN shows an individual or HUF (for example contractors). */
  rateIndividualHuf?: string | null;
  /** Rate when the counterparty has no PAN on file. The higher of this and the normal rate applies. */
  rateNoPan: string;
  /** One document above this is subject to tax even if the window's aggregate is not. */
  singleThreshold?: string | null;
  /** The window's aggregate (including this document) above this is subject to tax. */
  aggregateThreshold?: string | null;
  window: ThresholdWindow;
  basis: ThresholdBasis;
}

/** What earlier posted documents of the same counterparty, section and window already counted. */
export interface WithholdingHistory {
  /** Sum of the amounts earlier documents counted toward the threshold. */
  aggregateBefore: string;
  /** Sum of the amounts tax was already worked out on. */
  taxedBefore: string;
}

export interface WithholdingResult {
  /** This document's amount, counted toward the threshold. */
  subject: string;
  /** The amount tax is worked out on (may include earlier documents once a threshold is crossed). */
  base: string;
  /** Percent applied. */
  rate: string;
  amount: string;
  reason: string;
}

const HOLDER_TYPES: Record<string, string> = {
  P: 'Individual',
  H: 'Hindu undivided family',
  C: 'Company',
  F: 'Firm or LLP',
  A: 'Association of persons',
  B: 'Body of individuals',
  T: 'Trust',
  L: 'Local authority',
  J: 'Artificial juridical person',
  G: 'Government',
};

export interface PanCheck {
  valid: boolean;
  pan: string;
  issues: string[];
  /** From the PAN's fourth character. */
  holderType?: string;
  isIndividualOrHuf?: boolean;
}

/** Shape check only (five letters, four digits, one letter; the fourth letter is the holder type). Nothing is asked of the income-tax portal. */
export function checkPan(input: string): PanCheck {
  const pan = (input ?? '').trim().toUpperCase();
  const issues: string[] = [];
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) issues.push('A PAN is five letters, four digits and a letter, like ABCPE1234F');
  else if (!HOLDER_TYPES[pan[3]]) issues.push(`The fourth character "${pan[3]}" is not a PAN holder type`);
  if (issues.length) return { valid: false, pan, issues };
  return { valid: true, pan, issues, holderType: HOLDER_TYPES[pan[3]], isIndividualOrHuf: pan[3] === 'P' || pan[3] === 'H' };
}

/** A GSTIN carries the holder's PAN in characters 3 to 12. */
export function panFromGstin(gstin: string): string {
  return gstin.slice(2, 12);
}

/** TAN: four letters, five digits, one letter. */
export function tanIssue(input: string): string | null {
  return /^[A-Z]{4}[0-9]{5}[A-Z]$/.test((input ?? '').trim().toUpperCase()) ? null : 'A TAN is four letters, five digits and a letter, like PNEA12345B';
}

/** The tax year (1 April to 31 March) a date falls in. */
export function taxYearOf(iso: string): { from: string; to: string; label: string } {
  const y = Number(iso.slice(0, 4));
  const start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `${start}-${String((start + 1) % 100).padStart(2, '0')}` };
}

function lastDayOfMonth(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The window whose aggregate a document dated `iso` counts toward. */
export function thresholdWindow(window: ThresholdWindow, iso: string): { from: string; to: string } {
  if (window === 'MONTH') return { from: `${iso.slice(0, 7)}-01`, to: lastDayOfMonth(iso) };
  const t = taxYearOf(iso);
  return { from: t.from, to: t.to };
}

/** Quarter of the tax year (Q1 = April to June), as used by the quarterly TDS and TCS statements. */
export function taxQuarterOf(iso: string): { quarter: 1 | 2 | 3 | 4; from: string; to: string; label: string } {
  const t = taxYearOf(iso);
  const m = Number(iso.slice(5, 7));
  const q = (m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4) as 1 | 2 | 3 | 4;
  const startMonth = [4, 7, 10, 1][q - 1];
  const year = q === 4 ? Number(t.from.slice(0, 4)) + 1 : Number(t.from.slice(0, 4));
  const from = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  return { quarter: q, from, to: lastDayOfMonth(`${year}-${String(startMonth + 2).padStart(2, '0')}-01`), label: `Q${q} ${t.label}` };
}

/**
 * Date by which tax deducted or collected in the month of `iso` is due to the
 * government: the 7th of the next month, and 30 April for March. (These are the
 * dates for deductors other than government offices; confirm them against the
 * current Income-tax Rules.)
 */
export function depositDueDate(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-07`;
}

/** Rate for a counterparty: the individual/HUF rate where it applies, and the no-PAN rate (if higher) when there is no PAN. */
export function withholdingRate(rule: WithholdingRule, pan: string | null): { rate: Dec; reason: string } {
  const normal = dec(rule.rate);
  if (!pan) {
    const noPan = dec(rule.rateNoPan);
    return noPan.gt(normal) ? { rate: noPan, reason: `no PAN on file, so ${noPan.toFixed()}% applies` } : { rate: normal, reason: 'no PAN on file' };
  }
  const p = checkPan(pan);
  if (p.isIndividualOrHuf && rule.rateIndividualHuf) return { rate: dec(rule.rateIndividualHuf), reason: `${p.holderType?.toLowerCase()} rate` };
  return { rate: normal, reason: '' };
}

/**
 * Tax to withhold on one document.
 *
 * WHOLE basis (most TDS items, s.393(1)(a)): when the window's aggregate,
 * including this document, exceeds the aggregate threshold, tax applies to the
 * whole aggregate less what was already taxed, so earlier documents below the
 * threshold are caught up on this one. Otherwise, when this document alone
 * exceeds the single threshold, tax applies to this document.
 *
 * EXCESS basis (purchase of goods, Sl. No. 8(ii)): tax applies only to the part
 * of the aggregate above the threshold, less what was already taxed.
 *
 * "Exceeds" is strictly greater. The tax is rounded to the currency (half-even).
 */
export function computeWithholding(rule: WithholdingRule, amount: string, history: WithholdingHistory, pan: string | null, currency = 'INR'): WithholdingResult {
  const subject = dec(amount);
  if (subject.isNegative()) throw new Error('Amount cannot be negative');
  const before = dec(history.aggregateBefore);
  const taxed = dec(history.taxedBefore);
  const aggregate = before.plus(subject);
  const aggT = rule.aggregateThreshold ? dec(rule.aggregateThreshold) : null;
  const singleT = rule.singleThreshold ? dec(rule.singleThreshold) : null;
  const win = rule.window === 'MONTH' ? 'this month' : 'this tax year';
  let base = new D(0);
  let why: string;
  if (rule.basis === 'EXCESS') {
    const over = aggT ? D.max(aggregate.minus(aggT), 0) : aggregate;
    base = D.max(over.minus(taxed), 0);
    why = base.gt(0) ? `on the part of ${win}'s ${aggregate.toFixed(2)} above ${aggT?.toFixed(2) ?? '0'}` : `${win}'s total ${aggregate.toFixed(2)} is not above ${aggT?.toFixed(2)}`;
  } else if (aggT && aggregate.gt(aggT)) {
    base = D.max(aggregate.minus(taxed), 0);
    why = base.gt(subject) ? `${win}'s total ${aggregate.toFixed(2)} is above ${aggT.toFixed(2)}, so earlier amounts of ${base.minus(subject).toFixed(2)} are included` : `${win}'s total ${aggregate.toFixed(2)} is above ${aggT.toFixed(2)}`;
  } else if (singleT && subject.gt(singleT)) {
    base = subject;
    why = `this amount is above ${singleT.toFixed(2)}`;
  } else if (!aggT && !singleT) {
    base = subject;
    why = 'no threshold';
  } else {
    why = [singleT ? `not above ${singleT.toFixed(2)} on its own` : '', aggT ? `${win}'s total ${aggregate.toFixed(2)} is not above ${aggT.toFixed(2)}` : ''].filter(Boolean).join(', and ');
  }
  const r = withholdingRate(rule, pan);
  const tax = base.gt(0) ? roundToCurrency(base.times(r.rate).dividedBy(100), currency) : new D(0);
  return { subject: subject.toFixed(2), base: base.toFixed(2), rate: r.rate.toFixed(), amount: tax.toFixed(2), reason: [why, r.reason].filter(Boolean).join('; ') };
}

export interface WithholdingTemplate extends Omit<WithholdingRule, 'kind'> {
  kind: 'TDS';
  /** First date the provision applies (the 2025 Act's commencement). */
  validFrom: string;
  source: string;
}

const S393 = 'Income-tax Act 2025, s.393(1) Table';

/**
 * Starting points for common business payments to residents. The no-PAN rate is
 * a configurable default of 20%, as under the previous Act's s.206AA; confirm it
 * against the current Act before relying on it.
 */
export const TDS_TEMPLATES: readonly WithholdingTemplate[] = Object.freeze([
  { kind: 'TDS', code: '393(1)-6(i)', name: 'Contractors (work, including supply of labour)', rate: '2', rateIndividualHuf: '1', rateNoPan: '20', singleThreshold: '30000', aggregateThreshold: '100000', window: 'TAX_YEAR', basis: 'WHOLE', validFrom: '2026-04-01', source: `${S393} Sl. No. 6(i)` },
  { kind: 'TDS', code: '393(1)-6(iii)(a)', name: 'Fees for technical services (not professional)', rate: '2', rateNoPan: '20', aggregateThreshold: '50000', window: 'TAX_YEAR', basis: 'WHOLE', validFrom: '2026-04-01', source: `${S393} Sl. No. 6(iii)(a)` },
  { kind: 'TDS', code: '393(1)-6(iii)(b)', name: 'Fees for professional services', rate: '10', rateNoPan: '20', aggregateThreshold: '50000', window: 'TAX_YEAR', basis: 'WHOLE', validFrom: '2026-04-01', source: `${S393} Sl. No. 6(iii)(b)` },
  { kind: 'TDS', code: '393(1)-1(ii)', name: 'Commission or brokerage', rate: '2', rateNoPan: '20', aggregateThreshold: '20000', window: 'TAX_YEAR', basis: 'WHOLE', validFrom: '2026-04-01', source: `${S393} Sl. No. 1(ii)` },
  { kind: 'TDS', code: '393(1)-2(ii)(a)', name: 'Rent of plant, machinery or equipment', rate: '2', rateNoPan: '20', aggregateThreshold: '50000', window: 'MONTH', basis: 'WHOLE', validFrom: '2026-04-01', source: `${S393} Sl. No. 2(ii)(a)` },
  { kind: 'TDS', code: '393(1)-2(ii)(b)', name: 'Rent of land, building, furniture or fittings', rate: '10', rateNoPan: '20', aggregateThreshold: '50000', window: 'MONTH', basis: 'WHOLE', validFrom: '2026-04-01', source: `${S393} Sl. No. 2(ii)(b)` },
  { kind: 'TDS', code: '393(1)-8(ii)', name: 'Purchase of goods', rate: '0.1', rateNoPan: '5', aggregateThreshold: '5000000', window: 'TAX_YEAR', basis: 'EXCESS', validFrom: '2026-04-01', source: `${S393} Sl. No. 8(ii)` },
]);
