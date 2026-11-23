import { D, type Dec } from '@talk2tax/accounting-engine';

/**
 * UK VAT return (TAX-030): the nine boxes HMRC asks for, prepared from the books on the invoice
 * (accrual) basis, for VAT periods on the business's stagger, with the VAT registration number
 * check, corrections of earlier returns and the HMRC threshold for correcting on the next return.
 *
 * What goes in:
 * - Sales: posted invoices and credit notes by issue date (credit notes subtract); bills and vendor
 *   credits the same way on the purchase side; approved expense claims by their posting date.
 * - A voided document or claim stays in the period it was dated in and is taken off again in the
 *   period it was voided, as the ledger does, so a filed period never changes because of a void.
 * - Each line's tax rate has a VAT treatment, set by the business (or suggested from the rate):
 *   standard, reduced and zero-rated supplies count in boxes 1/4 and 6/7; exempt supplies count in
 *   boxes 6/7 with no VAT; supplies outside the scope of VAT count nowhere.
 *
 * The boxes (HMRC "VAT Notice 700/12"):
 *   1 VAT due on sales; 2 VAT due on acquisitions of goods from the EU (Northern Ireland only);
 *   3 = 1 + 2; 4 VAT reclaimed on purchases; 5 = the difference between 3 and 4, as a positive
 *   figure (box 3 > box 4 means VAT to pay); 6 total sales excluding VAT; 7 total purchases
 *   excluding VAT; 8 goods supplied to the EU and 9 goods acquired from the EU (Northern Ireland
 *   only). Boxes 1 to 5 are in pounds and pence; boxes 6 to 9 in whole pounds, pence left off.
 *
 * Not modelled: the cash accounting, flat rate, annual accounting and margin schemes, the domestic
 * reverse charge, postponed import VAT, partial exemption and Northern Ireland EU trade (boxes 2,
 * 8 and 9 are always 0). Nothing is sent to HMRC: the figures are entered in MTD software or the
 * HMRC service by the business, which then records the submission here.
 */

export const VAT_TREATMENTS = ['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];
export const VAT_TREATMENT_LABEL: Record<VatTreatment, string> = {
  STANDARD: 'Standard rate',
  REDUCED: 'Reduced rate',
  ZERO: 'Zero rate',
  EXEMPT: 'Exempt',
  OUTSIDE_SCOPE: 'Outside the scope of VAT',
};
/** The UK rates as published on GOV.UK "VAT rates"; a rate set otherwise is flagged, not changed. */
export const UK_VAT_RATE: Partial<Record<VatTreatment, string>> = { STANDARD: '20', REDUCED: '5', ZERO: '0' };

/** How often returns are made: monthly, or quarterly on one of HMRC's three staggers. */
export const VAT_STAGGERS = ['MONTHLY', 'QUARTERLY_MAR', 'QUARTERLY_APR', 'QUARTERLY_MAY'] as const;
export type VatStagger = (typeof VAT_STAGGERS)[number];
export const VAT_STAGGER_LABEL: Record<VatStagger, string> = {
  MONTHLY: 'Monthly',
  QUARTERLY_MAR: 'Quarterly, ending March, June, September and December',
  QUARTERLY_APR: 'Quarterly, ending April, July, October and January',
  QUARTERLY_MAY: 'Quarterly, ending May, August, November and February',
};

/** HMRC: an error can go on the next return if the net value is at most £10,000, or 1% of box 6 up to £50,000. */
export const VAT_CORRECTION_LIMIT = { floor: '10000', cap: '50000', share: '0.01' } as const;

// ---- dates (YYYY-MM-DD, calendar arithmetic, no time zones) ----

const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // not money: m is 1-12
const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(daysIn(y, m))}`;
/** y/m moved by `by` months (m 1-12). */
function shift(y: number, m: number, by: number): [number, number] {
  const t = y * 12 + (m - 1) + by; // not money
  return [Math.floor(t / 12), (t % 12) + 1]; // not money
}

/** The VAT period ending on `end`: its first day and the due date (one calendar month and seven days after it ends). */
export function vatPeriodFor(stagger: VatStagger, end: string) {
  const y = Number(end.slice(0, 4)); // not money
  const m = Number(end.slice(5, 7)); // not money
  if (end !== monthEnd(y, m)) return null;
  const length = stagger === 'MONTHLY' ? 1 : 3; // not money
  if (length === 3) {
    const offset = { QUARTERLY_MAR: 0, QUARTERLY_APR: 1, QUARTERLY_MAY: 2, MONTHLY: 0 }[stagger]; // not money
    if ((m - offset + 12) % 3 !== 0) return null; // not money: March, June... for the first stagger
  }
  const [sy, sm] = shift(y, m, -(length - 1)); // not money
  return { start: `${sy}-${pad(sm)}-01`, end, due: vatDueDate(end) };
}

/** A return and its payment are due one calendar month and seven days after the period ends. */
export function vatDueDate(end: string) {
  // One calendar month after a month's last day is the next month's last day.
  const [dy, dm] = shift(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 1); // not money
  return addDaysIso(monthEnd(dy, dm), 7);
}

function addDaysIso(iso: string, days: number) {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days); // not money
  return t.toISOString().slice(0, 10);
}

/** The `count` most recent VAT periods that have started by `today`, newest first. */
export function recentVatPeriods(stagger: VatStagger, today: string, count: number) {
  const out: NonNullable<ReturnType<typeof vatPeriodFor>>[] = [];
  let [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]; // not money
  // Walk forward to the end of the period that holds today, then back.
  for (let i = 0; i < 3 && !vatPeriodFor(stagger, monthEnd(y, m)); i++) [y, m] = shift(y, m, 1); // not money
  const step = stagger === 'MONTHLY' ? 1 : 3; // not money
  while (out.length < count) {
    const p = vatPeriodFor(stagger, monthEnd(y, m))!;
    if (p.start <= today) out.push(p);
    [y, m] = shift(y, m, -step);
  }
  return out;
}

// ---- VAT registration number ----

/**
 * A UK VAT registration number: 9 digits (12 with a branch suffix), with or without "GB" and
 * spaces, passing HMRC's modulus 97 check (the original or the "9755" variant). Returns the
 * normalised number (GB and digits) or null.
 */
export function normaliseVrn(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  const digits = s.startsWith('GB') ? s.slice(2) : s;
  if (!/^\d{9}(\d{3})?$/.test(digits)) return null;
  const d = digits.slice(0, 9).split('').map(Number);
  let total = 0; // not money: check digits
  for (let i = 0; i < 7; i++) total += d[i]! * (8 - i); // not money
  total += d[7]! * 10 + d[8]!; // not money
  if (total % 97 !== 0 && (total + 55) % 97 !== 0) return null; // not money
  return `GB${digits}`;
}

// ---- treatments ----

/** A treatment suggested from a rate's percentage and name, or null when the business must choose. */
export function suggestVatTreatment(rate: string, name: string): VatTreatment | null {
  const r = new D(rate);
  const n = name.toLowerCase();
  if (r.eq(20)) return 'STANDARD';
  if (r.eq(5)) return 'REDUCED';
  if (!r.isZero()) return null;
  if (n.includes('exempt')) return 'EXEMPT';
  if (n.includes('outside') || n.includes('out of scope') || n.includes('no vat')) return 'OUTSIDE_SCOPE';
  return 'ZERO';
}

// ---- the return ----

export const VAT_ENTRY_SOURCES = ['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT', 'EXPENSE_CLAIM'] as const;
export type VatEntrySource = (typeof VAT_ENTRY_SOURCES)[number];

/** One line of a document or claim, in pounds, with the sign it carries on the return. */
export interface VatEntry {
  source: VatEntrySource;
  /** The document or claim. */
  id: string;
  number: string;
  date: string;
  /** A void taken off in this period. */
  reversal?: boolean;
  taxRateId: string | null;
  /** The rate on the line, percent. */
  rate: string;
  net: string;
  vat: string;
}

export interface VatRateInfo {
  id: string;
  name: string;
  rate: string;
  /** Set by the business; else suggested. */
  treatment: VatTreatment | null;
}

export interface VatCorrection {
  /** The earlier period corrected. */
  periodEnd: string;
  box1: string;
  box4: string;
}

export interface VatBoxes {
  box1: string;
  box2: string;
  box3: string;
  box4: string;
  box5: string;
  box6: string;
  box7: string;
  box8: string;
  box9: string;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const SALES: ReadonlySet<VatEntrySource> = new Set(['INVOICE', 'CREDIT_NOTE']);
const NEGATIVE: ReadonlySet<VatEntrySource> = new Set(['CREDIT_NOTE', 'VENDOR_CREDIT']);

/** The figures of the period's own entries, before corrections (kept with a filed return to find later changes). */
export interface VatOwnFigures {
  box1: string;
  box4: string;
  box6: string;
  box7: string;
}

/**
 * The return for a period: the nine boxes, the figures by treatment, the rates that still need a
 * treatment (which block submission) and warnings. `untaxed` is the treatment of lines with no tax
 * rate. Corrections of earlier periods go in box 1 (output VAT) and box 4 (input VAT).
 */
export function ukVatReturn(entries: readonly VatEntry[], rates: readonly VatRateInfo[], opts: { untaxed: VatTreatment; corrections?: readonly VatCorrection[] }) {
  const byId = new Map(rates.map((r) => [r.id, r]));
  const sum = { out: new D(0), in: new D(0), sales: new D(0), purchases: new D(0) };
  const groups = new Map<string, { side: 'SALES' | 'PURCHASES'; treatment: VatTreatment; net: Dec; vat: Dec; lines: number }>();
  const unclassified = new Map<string, { id: string; name: string; rate: string; lines: number }>();
  const warnings: string[] = [];
  let untaxedLines = 0; // not money: count
  let vatOnNoVat = 0; // not money: count
  for (const e of entries) {
    const rate = e.taxRateId ? byId.get(e.taxRateId) : undefined;
    let treatment: VatTreatment | null;
    if (!e.taxRateId) {
      treatment = opts.untaxed;
      untaxedLines++;
    } else treatment = rate ? (rate.treatment ?? suggestVatTreatment(rate.rate, rate.name)) : null;
    if (!treatment) {
      const u = unclassified.get(e.taxRateId!) ?? { id: e.taxRateId!, name: rate?.name ?? 'A deleted tax rate', rate: rate?.rate ?? e.rate, lines: 0 };
      u.lines++;
      unclassified.set(e.taxRateId!, u);
      continue;
    }
    const sign = (NEGATIVE.has(e.source) ? -1 : 1) * (e.reversal ? -1 : 1); // not money: a direction
    const net = new D(e.net).times(sign);
    const vat = new D(e.vat).times(sign);
    const sales = SALES.has(e.source);
    if ((treatment === 'EXEMPT' || treatment === 'OUTSIDE_SCOPE') && !vat.isZero()) vatOnNoVat++;
    if (treatment !== 'OUTSIDE_SCOPE') {
      if (sales) {
        sum.out = sum.out.plus(treatment === 'EXEMPT' ? 0 : vat);
        sum.sales = sum.sales.plus(net);
      } else {
        sum.in = sum.in.plus(treatment === 'EXEMPT' ? 0 : vat);
        sum.purchases = sum.purchases.plus(net);
      }
    }
    const key = `${sales ? 'SALES' : 'PURCHASES'}:${treatment}`;
    const g = groups.get(key) ?? { side: sales ? 'SALES' : 'PURCHASES', treatment, net: new D(0), vat: new D(0), lines: 0 };
    g.net = g.net.plus(net);
    g.vat = g.vat.plus(vat);
    g.lines++;
    groups.set(key, g);
  }
  const corr = (opts.corrections ?? []).reduce((a, c) => ({ box1: a.box1.plus(c.box1), box4: a.box4.plus(c.box4) }), { box1: new D(0), box4: new D(0) });
  const own: VatOwnFigures = { box1: sum.out.toFixed(2), box4: sum.in.toFixed(2), box6: sum.sales.toFixed(2), box7: sum.purchases.toFixed(2) };
  const box1 = new D(own.box1).plus(corr.box1);
  const box3 = box1; // box 2 is 0: no Northern Ireland EU acquisitions
  const box4 = new D(own.box4).plus(corr.box4);
  const pounds = (x: Dec) => x.toFixed(0, 1); // whole pounds, pence left off (rounding toward zero)
  const boxes: VatBoxes = {
    box1: box1.toFixed(2),
    box2: '0.00',
    box3: box3.toFixed(2),
    box4: box4.toFixed(2),
    box5: box3.minus(box4).abs().toFixed(2),
    box6: pounds(sum.sales),
    box7: pounds(sum.purchases),
    box8: '0',
    box9: '0',
  };
  const direction: 'PAY' | 'RECLAIM' | 'NIL' = box3.gt(box4) ? 'PAY' : box3.lt(box4) ? 'RECLAIM' : 'NIL';

  if (untaxedLines) warnings.push(`${untaxedLines} ${untaxedLines === 1 ? 'line has' : 'lines have'} no tax rate and ${untaxedLines === 1 ? 'is' : 'are'} treated as ${lower(VAT_TREATMENT_LABEL[opts.untaxed])}`);
  if (vatOnNoVat) warnings.push(`${vatOnNoVat} exempt or outside-scope ${vatOnNoVat === 1 ? 'line carries' : 'lines carry'} VAT, which is left off the return; check the rate on ${vatOnNoVat === 1 ? 'it' : 'them'}`);
  const used = new Set(entries.map((e) => e.taxRateId));
  for (const r of rates) {
    if (!used.has(r.id)) continue;
    const t = r.treatment ?? suggestVatTreatment(r.rate, r.name);
    const expected = t ? UK_VAT_RATE[t] : undefined;
    if (expected !== undefined && !new D(r.rate).eq(expected)) warnings.push(`${r.name} is ${new D(r.rate).toFixed()}% but set as ${lower(VAT_TREATMENT_LABEL[t!])}, which is ${expected}% in the UK`);
  }
  const issues = [...unclassified.values()].map((u) => `Choose the VAT treatment of ${u.name} (${new D(u.rate).toFixed()}%, ${u.lines} ${u.lines === 1 ? 'line' : 'lines'})`);

  const order = (s: string) => (s.startsWith('SALES') ? 0 : 10) + VAT_TREATMENTS.indexOf(s.split(':')[1] as VatTreatment); // not money: sort key
  return {
    boxes,
    direction,
    own,
    corrections: { box1: corr.box1.toFixed(2), box4: corr.box4.toFixed(2) },
    breakdown: [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([, g]) => ({ side: g.side, treatment: g.treatment, label: VAT_TREATMENT_LABEL[g.treatment], net: g.net.toFixed(2), vat: g.vat.toFixed(2), lines: g.lines, counted: g.treatment !== 'OUTSIDE_SCOPE' })),
    unclassified: [...unclassified.values()],
    issues,
    warnings,
  };
}

/**
 * What changed in an earlier filed period: its figures now less those filed and less corrections
 * already made on later returns. Zero when nothing changed.
 */
export function vatPeriodChange(filed: VatOwnFigures, now: VatOwnFigures, alreadyCorrected: readonly { box1: string; box4: string }[]) {
  const done = alreadyCorrected.reduce((a, c) => ({ box1: a.box1.plus(c.box1), box4: a.box4.plus(c.box4) }), { box1: new D(0), box4: new D(0) });
  const box1 = new D(now.box1).minus(filed.box1).minus(done.box1);
  const box4 = new D(now.box4).minus(filed.box4).minus(done.box4);
  return { box1: box1.toFixed(2), box4: box4.toFixed(2), net: box1.minus(box4).toFixed(2), changed: !box1.isZero() || !box4.isZero() };
}

/**
 * Whether the net value of the corrections can go on this return: at most £10,000, or 1% of this
 * return's box 6 up to £50,000. Above that the errors are reported to HMRC separately (form VAT652).
 */
export function vatCorrectionAllowance(corrections: readonly { box1: string; box4: string }[], box6: string) {
  const net = corrections.reduce((a, c) => a.plus(c.box1).minus(c.box4), new D(0));
  const share = D.min(new D(box6).times(VAT_CORRECTION_LIMIT.share), VAT_CORRECTION_LIMIT.cap);
  const limit = D.max(VAT_CORRECTION_LIMIT.floor, share);
  return { net: net.toFixed(2), limit: limit.toFixed(2), allowed: net.abs().lte(limit) };
}

/** HMRC's box names, for the page, the CSV and the help. */
export const VAT_BOX_LABEL: Record<keyof VatBoxes, string> = {
  box1: 'VAT due on sales and other outputs',
  box2: 'VAT due on acquisitions of goods from the EU (Northern Ireland)',
  box3: 'Total VAT due (box 1 + box 2)',
  box4: 'VAT reclaimed on purchases and other inputs',
  box5: 'Net VAT to pay to HMRC or reclaim',
  box6: 'Total value of sales and other outputs, excluding VAT',
  box7: 'Total value of purchases and other inputs, excluding VAT',
  box8: 'Total value of goods supplied to the EU (Northern Ireland)',
  box9: 'Total value of goods acquired from the EU (Northern Ireland)',
};

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The boxes and the entries behind them as CSV text (UK box names unless others are given). */
export function vatReturnCsv(period: { start: string; end: string }, boxes: VatBoxes | Record<string, string>, entries: readonly (VatEntry & { treatment: string })[], opts: { title?: string; labels?: Record<string, string> } = {}) {
  const labels: Record<string, string> = opts.labels ?? VAT_BOX_LABEL;
  const values = boxes as Record<string, string>;
  const rows: string[][] = [[opts.title ?? 'VAT return', `${period.start} to ${period.end}`], [], ['Box', 'Description', 'Value']];
  for (const k of Object.keys(labels)) rows.push([k.replace('box', ''), labels[k]!, values[k] ?? '']);
  rows.push([], ['Source', 'Number', 'Date', 'Reversal', 'Treatment', 'Rate', 'Net', 'VAT']);
  for (const e of entries) rows.push([e.source, e.number, e.date, e.reversal ? 'yes' : '', e.treatment, e.rate, e.net, e.vat]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
