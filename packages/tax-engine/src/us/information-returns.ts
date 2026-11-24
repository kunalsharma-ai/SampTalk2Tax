import { D } from '@talk2tax/accounting-engine';

/**
 * US federal and state tax reporting (TAX-029). Federal: the Form 1099-NEC and 1099-MISC
 * information returns a business files for what it paid vendors in a calendar year, worked out
 * from its own vendor payments and what each vendor's Form W-9 says. State: the sales tax returns
 * each state permit (TAX-028) calls for in a year, with the tax charged in each period.
 *
 * The rules are written from IRS instructions as known when checked (US_REPORTING_CHECKED_ON) and
 * need review by a US tax adviser before anyone relies on them. Talk2Tax files nothing with the
 * IRS or any state.
 */

export const US_REPORTING_CHECKED_ON = '2026-11-24';

/** The tax classification a vendor ticks on Form W-9. Single-member LLCs that are disregarded tick INDIVIDUAL. */
export const W9_CLASSIFICATIONS = ['INDIVIDUAL', 'PARTNERSHIP', 'C_CORPORATION', 'S_CORPORATION', 'TRUST_ESTATE', 'LLC_C', 'LLC_S', 'LLC_P', 'EXEMPT_PAYEE'] as const;
export type W9Classification = (typeof W9_CLASSIFICATIONS)[number];

export const W9_CLASSIFICATION_LABEL: Readonly<Record<W9Classification, string>> = {
  INDIVIDUAL: 'Individual, sole proprietor or single-member LLC',
  PARTNERSHIP: 'Partnership',
  C_CORPORATION: 'C corporation',
  S_CORPORATION: 'S corporation',
  TRUST_ESTATE: 'Trust or estate',
  LLC_C: 'LLC taxed as a C corporation',
  LLC_S: 'LLC taxed as an S corporation',
  LLC_P: 'LLC taxed as a partnership',
  EXEMPT_PAYEE: 'Exempt payee (for example a tax-exempt organisation or government body)',
};

const CORPORATE: ReadonlySet<W9Classification> = new Set(['C_CORPORATION', 'S_CORPORATION', 'LLC_C', 'LLC_S']);

/** What the payments to a vendor are for, which decides the form and box. */
export const FORM_1099_KINDS = ['NEC', 'MISC_RENT', 'MISC_OTHER', 'NONE'] as const;
export type Form1099Kind = (typeof FORM_1099_KINDS)[number];

export const FORM_1099_KIND_LABEL: Readonly<Record<Form1099Kind, string>> = {
  NEC: '1099-NEC box 1: services by a non-employee',
  MISC_RENT: '1099-MISC box 1: rents',
  MISC_OTHER: '1099-MISC box 3: other income (prizes, awards and similar)',
  NONE: 'Not reportable (goods, merchandise, freight or storage)',
};

/**
 * The reporting threshold for payments made in a calendar year. It was $600 for many years; the
 * One Big Beautiful Bill Act (2025) raised it to $2,000 for payments made after 31 December 2025,
 * indexed for inflation after 2026. Years after 2026 use $2,000 until the indexed figure is known.
 */
export function form1099Threshold(year: number): string {
  return year >= 2026 ? '2000' : '600';
}

/** Businesses that file this many information returns in a year (all types together) must file them electronically. */
export const E_FILE_THRESHOLD = 10;

const pad = (n: number) => String(n).padStart(2, '0');

/** Moves a due date on a Saturday or Sunday to the Monday. Federal holidays also move it; check the IRS calendar. */
export function nextWeekday(iso: string): string {
  const t = new Date(`${iso}T00:00:00Z`);
  const day = t.getUTCDay();
  if (day === 6)
    t.setUTCDate(t.getUTCDate() + 2); // not money
  else if (day === 0) t.setUTCDate(t.getUTCDate() + 1); // not money
  return t.toISOString().slice(0, 10);
}

/** Due dates for the returns for payments made in `year`. */
export function form1099DueDates(year: number) {
  const next = year + 1; // not money
  return {
    necRecipientAndIrs: nextWeekday(`${next}-01-31`),
    miscRecipient: nextWeekday(`${next}-01-31`),
    miscIrsPaper: nextWeekday(`${next}-02-28`),
    miscIrsElectronic: nextWeekday(`${next}-03-31`),
  };
}

/** A vendor as its W-9 describes it. Only the last four digits of the taxpayer identification number are kept. */
export interface VendorTaxProfile {
  contactId: string;
  classification: W9Classification;
  tinType: 'SSN' | 'EIN';
  tinLast4: string | null;
  w9ReceivedOn: string | null;
  formKind: Form1099Kind;
  /** Payments for legal services are reportable even when the law firm is a corporation. */
  isAttorney: boolean;
}

export interface VendorPaymentFact {
  contactId: string;
  date: string;
  /** In the functional currency (US dollars), positive. */
  amount: string;
  /** Paid by credit or debit card or a payment network: the card company reports these on Form 1099-K. */
  byCard: boolean;
}

export interface VendorFact {
  contactId: string;
  name: string;
  /** The vendor's country, when known. Vendors outside the US get Form 1042-S, not a 1099. */
  countryCode: string | null;
}

export type Vendor1099Status = 'REPORTABLE' | 'NEEDS_W9' | 'BELOW_THRESHOLD' | 'CORPORATION' | 'EXEMPT_PAYEE' | 'NOT_REPORTABLE_KIND' | 'CARD_ONLY' | 'FOREIGN';

export const VENDOR_1099_STATUS_LABEL: Readonly<Record<Vendor1099Status, string>> = {
  REPORTABLE: 'File a 1099',
  NEEDS_W9: 'Get a W-9',
  BELOW_THRESHOLD: 'Below the threshold',
  CORPORATION: 'Corporation, not reported',
  EXEMPT_PAYEE: 'Exempt payee',
  NOT_REPORTABLE_KIND: 'Goods, not reported',
  CARD_ONLY: 'Paid by card, on the 1099-K',
  FOREIGN: 'Outside the US, 1042-S instead',
};

export interface Vendor1099Row {
  contactId: string;
  name: string;
  status: Vendor1099Status;
  form: 'NEC' | 'MISC' | null;
  box: string | null;
  totalPaid: string;
  paidByCard: string;
  reportable: string;
  payments: number;
  classification: W9Classification | null;
  tinType: 'SSN' | 'EIN' | null;
  tinLast4: string | null;
  w9ReceivedOn: string | null;
  isAttorney: boolean;
  reason: string;
}

/**
 * The 1099s due for payments made in `year`. Every vendor paid in the year gets a row with why it is
 * or is not reported, so nobody is silently left out.
 */
export function information1099Returns(input: { year: number; vendors: VendorFact[]; payments: VendorPaymentFact[]; profiles: VendorTaxProfile[] }) {
  const threshold = form1099Threshold(input.year);
  const profiles = new Map(input.profiles.map((p) => [p.contactId, p]));
  const vendors = new Map(input.vendors.map((v) => [v.contactId, v]));
  const totals = new Map<string, { total: InstanceType<typeof D>; card: InstanceType<typeof D>; count: number }>();
  const prefix = `${input.year}-`;
  for (const p of input.payments) {
    if (!p.date.startsWith(prefix) || !vendors.has(p.contactId)) continue;
    const t = totals.get(p.contactId) ?? { total: new D(0), card: new D(0), count: 0 };
    t.total = t.total.plus(p.amount);
    if (p.byCard) t.card = t.card.plus(p.amount);
    t.count++;
    totals.set(p.contactId, t);
  }
  const rows: Vendor1099Row[] = [];
  for (const [contactId, t] of totals) {
    const v = vendors.get(contactId)!;
    const profile = profiles.get(contactId) ?? null;
    const reportable = t.total.minus(t.card);
    const base = {
      contactId,
      name: v.name,
      totalPaid: t.total.toFixed(2),
      paidByCard: t.card.toFixed(2),
      reportable: reportable.toFixed(2),
      payments: t.count,
      classification: profile?.classification ?? null,
      tinType: profile?.tinType ?? null,
      tinLast4: profile?.tinLast4 ?? null,
      w9ReceivedOn: profile?.w9ReceivedOn ?? null,
      isAttorney: profile?.isAttorney ?? false,
    };
    const row = (status: Vendor1099Status, reason: string, form: 'NEC' | 'MISC' | null = null, box: string | null = null): Vendor1099Row => ({ ...base, status, reason, form, box });
    if (v.countryCode && v.countryCode !== 'US') {
      rows.push(row('FOREIGN', 'Payments to a vendor outside the United States are reported on Form 1042-S, with withholding rules of their own.'));
      continue;
    }
    if (reportable.lte(0)) {
      rows.push(row('CARD_ONLY', 'Everything was paid by card or a payment network, which the card company reports on Form 1099-K.'));
      continue;
    }
    if (profile?.formKind === 'NONE') {
      rows.push(row('NOT_REPORTABLE_KIND', 'Payments for goods, merchandise, freight or storage are not reported on a 1099.'));
      continue;
    }
    if (profile?.classification === 'EXEMPT_PAYEE') {
      rows.push(row('EXEMPT_PAYEE', 'The vendor certified on its W-9 that it is an exempt payee.'));
      continue;
    }
    if (profile && CORPORATE.has(profile.classification) && !profile.isAttorney) {
      rows.push(row('CORPORATION', 'Payments to corporations are generally not reported. Legal services are the main exception.'));
      continue;
    }
    if (reportable.lt(threshold)) {
      rows.push(row('BELOW_THRESHOLD', `Paid less than $${new D(threshold).toFixed(0)} outside cards in ${input.year}.`));
      continue;
    }
    if (!profile || !profile.tinLast4 || !profile.w9ReceivedOn) {
      rows.push(row('NEEDS_W9', 'Paid above the threshold, but no W-9 is on record. Ask for one; without a taxpayer number backup withholding of 24% may apply to future payments.'));
      continue;
    }
    const form = profile.formKind === 'NEC' ? 'NEC' : 'MISC';
    const box = profile.formKind === 'MISC_OTHER' ? '3' : '1';
    rows.push(
      row(
        'REPORTABLE',
        profile.isAttorney && CORPORATE.has(profile.classification)
          ? 'Legal services are reported even when the firm is a corporation.'
          : `Paid $${reportable.toFixed(2)} outside cards, at or above the $${new D(threshold).toFixed(0)} threshold.`,
        form,
        box,
      ),
    );
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.contactId.localeCompare(b.contactId));
  const filing = rows.filter((r) => r.status === 'REPORTABLE' || r.status === 'NEEDS_W9');
  const sum = (rs: Vendor1099Row[]) => rs.reduce((s, r) => s.plus(r.reportable), new D(0)).toFixed(2);
  return {
    year: input.year,
    threshold,
    dueDates: form1099DueDates(input.year),
    rows,
    summary: {
      nec: rows.filter((r) => r.status === 'REPORTABLE' && r.form === 'NEC').length,
      misc: rows.filter((r) => r.status === 'REPORTABLE' && r.form === 'MISC').length,
      needsW9: rows.filter((r) => r.status === 'NEEDS_W9').length,
      reportableTotal: sum(filing),
      mustEfile: filing.length >= E_FILE_THRESHOLD,
    },
  };
}

const csvCell = (v: string | number | boolean | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** The reportable rows as CSV, for the business's filing software. Only the last four digits of a TIN are included. */
export function information1099Csv(report: ReturnType<typeof information1099Returns>) {
  const head = ['Vendor', 'Status', 'Form', 'Box', 'Amount', 'Paid by card', 'TIN type', 'TIN last 4', 'W-9 received', 'Attorney'];
  const lines = report.rows.map((r) =>
    [
      r.name,
      VENDOR_1099_STATUS_LABEL[r.status],
      r.form ? `1099-${r.form}` : '',
      r.box ?? '',
      r.reportable,
      r.paidByCard,
      r.tinType ?? '',
      r.tinLast4 ?? '',
      r.w9ReceivedOn ?? '',
      r.isAttorney ? 'Yes' : 'No',
    ]
      .map(csvCell)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n') + '\n';
}

export interface StateReturnPeriod {
  state: string;
  label: string;
  from: string;
  to: string;
  netSales: string;
  tax: string;
  invoices: number;
  /** Past, current (holds today) or future. */
  timing: 'PAST' | 'CURRENT' | 'FUTURE';
}

const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The periods of `year` a filing frequency divides it into. */
export function stateReturnPeriods(frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL', year: number) {
  const step = frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : 12;
  const out: { label: string; from: string; to: string }[] = [];
  for (let m = 1; m <= 12; m += step) {
    const last = m + step - 1; // not money
    const label = frequency === 'MONTHLY' ? `${MONTHS[m - 1]} ${year}` : frequency === 'QUARTERLY' ? `Q${(m + 2) / 3} ${year}` : `${year}`; // not money
    out.push({ label, from: `${year}-${pad(m)}-01`, to: monthEnd(year, last) });
  }
  return out;
}

/**
 * The sales tax returns each permit calls for in `year`, with the net sales and tax charged in that
 * state in each period (customer's state on the contact). Periods before the permit started are left out.
 */
export function stateSalesTaxReturns(input: {
  year: number;
  today: string;
  registrations: { state: string; registeredFrom: string; filingFrequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' }[];
  documents: { kind: 'INVOICE' | 'CREDIT_NOTE'; issueDate: string; state: string | null; net: string; tax: string }[];
}): StateReturnPeriod[] {
  const out: StateReturnPeriod[] = [];
  for (const r of [...input.registrations].sort((a, b) => a.state.localeCompare(b.state))) {
    for (const p of stateReturnPeriods(r.filingFrequency, input.year)) {
      if (p.to < r.registeredFrom) continue;
      const from = p.from < r.registeredFrom ? r.registeredFrom : p.from;
      let net = new D(0);
      let tax = new D(0);
      let invoices = 0;
      for (const d of input.documents) {
        if (d.state !== r.state || d.issueDate < from || d.issueDate > p.to) continue;
        const sign = d.kind === 'CREDIT_NOTE' ? -1 : 1;
        net = net.plus(new D(d.net).times(sign));
        tax = tax.plus(new D(d.tax).times(sign));
        if (d.kind === 'INVOICE') invoices++;
      }
      const timing = input.today > p.to ? 'PAST' : input.today >= p.from ? 'CURRENT' : 'FUTURE';
      out.push({ state: r.state, label: p.label, from, to: p.to, netSales: net.toFixed(2), tax: tax.toFixed(2), invoices, timing });
    }
  }
  return out;
}
