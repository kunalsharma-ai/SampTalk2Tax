/**
 * Tax audit support (TAX-026): working papers for the tax audit report (Form 3CA/3CB with Form
 * 3CD) of an Indian business for one financial year, worked out from the books. Deterministic and
 * explainable; amounts are decimal strings. It prepares figures for the auditor to check; it does
 * not file anything or replace the auditor's judgement.
 *
 * - Applicability (section 44AB(a)): turnover over 1 crore needs a tax audit; the limit is 10
 *   crore when cash received is at most 5% of all receipts and cash paid at most 5% of all payments.
 * - Clause 21(d) (section 40A(3)): expenditure paid in cash to one person in one day over 10,000
 *   (35,000 for transporters is not distinguished): the whole amount is disallowed.
 * - Clause 31(ba)/(bb) (section 269ST): 2 lakh or more received in cash from one person in one day.
 * - Clause 34(a)-(c): TDS deducted, deposited late or not at all, and interest under section
 *   201(1A)(ii) at 1.5% for every month or part of a month from deduction to deposit.
 * - Clause 44: total expenditure split by whether the supplier is registered for GST.
 */
import { D } from '@talk2tax/accounting-engine';

export const TAX_AUDIT_LIMIT = '10000000';
export const TAX_AUDIT_RAISED_LIMIT = '100000000';
export const CASH_PAYMENT_LIMIT = '10000';
export const CASH_RECEIPT_LIMIT = '200000';
export const TDS_INTEREST_RATE_PER_MONTH = '1.5';

export interface ApplicabilityFacts {
  turnover: string;
  totalReceipts: string;
  cashReceipts: string;
  totalPayments: string;
  cashPayments: string;
}

export interface TaxAuditApplicability {
  required: boolean;
  limit: string;
  cashReceiptsShare: string | null;
  cashPaymentsShare: string | null;
  reasons: string[];
}

const share = (part: string, whole: string) => (new D(whole).gt(0) ? new D(part).div(whole).times(100).toFixed(2) : null);
/** Indian digit grouping: 12345678.5 → 1,23,45,678.50. */
export function inr(v: string): string {
  const [int, frac] = new D(v).abs().toFixed(2).split('.') as [string, string];
  const last = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ',');
  return `${new D(v).isNegative() ? '-' : ''}${rest ? `${rest},` : ''}${last}.${frac}`;
}

export function taxAuditApplicability(f: ApplicabilityFacts): TaxAuditApplicability {
  const rs = share(f.cashReceipts, f.totalReceipts);
  const ps = share(f.cashPayments, f.totalPayments);
  const within = (part: string, whole: string) => new D(part).times(100).lte(new D(whole).times(5)); // at most 5%, exactly
  const lowCash = within(f.cashReceipts, f.totalReceipts) && within(f.cashPayments, f.totalPayments);
  const limit = lowCash ? TAX_AUDIT_RAISED_LIMIT : TAX_AUDIT_LIMIT;
  const required = new D(f.turnover).gt(limit);
  const reasons = [
    `Turnover ${inr(f.turnover)} against a limit of ${limit === TAX_AUDIT_LIMIT ? '1 crore' : '10 crore'}`,
    lowCash
      ? `Cash is at most 5% of receipts (${rs ?? '0.00'}%) and of payments (${ps ?? '0.00'}%), so the 10 crore limit applies`
      : `Cash is more than 5% of ${within(f.cashReceipts, f.totalReceipts) ? `payments (${ps}%)` : `receipts (${rs}%)`}, so the 1 crore limit applies`,
    required ? 'A tax audit is needed under section 44AB(a)' : 'No tax audit is needed under section 44AB(a) on turnover; check the other grounds (44AB(b) to (e)) with your auditor',
  ];
  return { required, limit, cashReceiptsShare: rs, cashPaymentsShare: ps, reasons };
}

export interface CashFact {
  id: string;
  date: string;
  contactId: string;
  contactName: string;
  amount: string;
  number: string;
}

export interface CashDayGroup {
  date: string;
  contactId: string;
  contactName: string;
  amount: string;
  count: number;
  numbers: string[];
}

/** Cash paid to or received from one person on one day, keeping the days over (or at) the limit. */
function cashDays(facts: readonly CashFact[], over: (amount: InstanceType<typeof D>) => boolean): CashDayGroup[] {
  const g = new Map<string, { f: CashFact; amount: InstanceType<typeof D>; count: number; numbers: string[] }>();
  for (const f of facts) {
    const k = `${f.date}|${f.contactId}`;
    const e = g.get(k) ?? { f, amount: new D(0), count: 0, numbers: [] };
    e.amount = e.amount.plus(f.amount);
    e.count += 1; // not money
    e.numbers.push(f.number);
    g.set(k, e);
  }
  return [...g.values()]
    .filter((e) => over(e.amount))
    .sort((a, b) => a.f.date.localeCompare(b.f.date) || a.f.contactName.localeCompare(b.f.contactName))
    .map((e) => ({ date: e.f.date, contactId: e.f.contactId, contactName: e.f.contactName, amount: e.amount.toFixed(2), count: e.count, numbers: e.numbers.sort() }));
}

/** Section 40A(3): cash paid to one person in one day over 10,000; the whole amount is disallowed. */
export const cashPaymentDisallowances = (payments: readonly CashFact[]) => cashDays(payments, (a) => a.gt(CASH_PAYMENT_LIMIT));
/** Section 269ST: 2 lakh or more received in cash from one person in one day. */
export const cashReceiptBreaches = (receipts: readonly CashFact[]) => cashDays(receipts, (a) => a.gte(CASH_RECEIPT_LIMIT));

export interface TdsFact {
  number: string;
  section: string;
  contactName: string;
  /** Date of deduction (the bill date). */
  date: string;
  dueDate: string;
  amount: string;
  depositDate: string | null;
}

export interface TdsLateRow extends TdsFact {
  months: number;
  interest: string;
  deposited: boolean;
}

/** Months or part of a month from `from` to `to` (at least one). */
export function monthsOrPart(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number];
  const whole = (y2 - y1) * 12 + (m2 - m1); // not money
  return Math.max(1, whole + (d2 > d1 ? 1 : 0)); // not money
}

/** Clause 34: TDS deposited after its due date, or not by `asOf`, with interest under section 201(1A)(ii). */
export function tdsLateDeposits(rows: readonly TdsFact[], asOf: string): { rows: TdsLateRow[]; deducted: string; deposited: string; late: number; notDeposited: string; interest: string } {
  const late: TdsLateRow[] = [];
  let deducted = new D(0);
  let deposited = new D(0);
  let notDeposited = new D(0);
  let interest = new D(0);
  for (const r of rows) {
    deducted = deducted.plus(r.amount);
    if (r.depositDate) deposited = deposited.plus(r.amount);
    else notDeposited = notDeposited.plus(r.amount);
    const paidOn = r.depositDate ?? asOf;
    if (paidOn <= r.dueDate || new D(r.amount).lte(0)) continue;
    const months = monthsOrPart(r.date, paidOn);
    const i = new D(r.amount).times(TDS_INTEREST_RATE_PER_MONTH).div(100).times(months).toDecimalPlaces(0, D.ROUND_UP);
    interest = interest.plus(i);
    late.push({ ...r, months, interest: i.toFixed(2), deposited: !!r.depositDate });
  }
  late.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  return { rows: late, deducted: deducted.toFixed(2), deposited: deposited.toFixed(2), late: late.length, notDeposited: notDeposited.toFixed(2), interest: interest.toFixed(2) };
}

export interface ExpenditureFact {
  /** Before GST, in the functional currency; negative for vendor credits. */
  amount: string;
  registered: boolean;
}

/** Clause 44: expenditure on bills split by whether the supplier was registered for GST. */
export function gstExpenditureBreakup(facts: readonly ExpenditureFact[]) {
  let reg = new D(0);
  let unreg = new D(0);
  for (const f of facts) {
    if (f.registered) reg = reg.plus(f.amount);
    else unreg = unreg.plus(f.amount);
  }
  return { total: reg.plus(unreg).toFixed(2), registered: reg.toFixed(2), unregistered: unreg.toFixed(2) };
}
