/**
 * Payment fraud indicators (AP-028): warning signs on vendor payments, both those waiting in
 * payment batches and those recorded in the last 90 days, worked out from what the books already
 * hold. Deterministic and explainable: every indicator says what it was raised on, no model or
 * outside data is used, and amounts are decimal strings, never JS numbers.
 *
 * Indicators, most serious first:
 * - HIGH: the vendor's bank account is an employee's salary account; another vendor has the same
 *   bank account; bank details changed in the 30 days before the payment and not verified since;
 *   another payment to the vendor for the same amount within 7 days (or the same bill in another
 *   open batch).
 * - MEDIUM: bank details changed in the 30 days before, verified; the vendor was added in the 30
 *   days before; the amount is over three times the vendor's largest payment in the year before
 *   (with at least three to compare); the payment is not set against any bill; the person who last
 *   changed the bank details also made the payment.
 * - LOW: another vendor has a name that is the same once spaces, punctuation and company words are
 *   ignored; a large round amount (a lakh or more, in whole thousands).
 */
import { addDays, daysBetween } from './documents';
import { D } from './money';

export const FRAUD_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type FraudLevel = (typeof FRAUD_LEVELS)[number];
export const FRAUD_LEVEL_LABEL: Record<FraudLevel, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

export const FRAUD_INDICATORS = [
  'EMPLOYEE_ACCOUNT',
  'SHARED_ACCOUNT',
  'BANK_CHANGED_UNVERIFIED',
  'DUPLICATE_PAYMENT',
  'BANK_CHANGED',
  'NEW_VENDOR',
  'UNUSUAL_AMOUNT',
  'NO_BILL',
  'SAME_PERSON',
  'SIMILAR_NAME',
  'ROUND_AMOUNT',
] as const;
export type FraudIndicatorCode = (typeof FRAUD_INDICATORS)[number];
export const FRAUD_INDICATOR_LEVEL: Record<FraudIndicatorCode, FraudLevel> = {
  EMPLOYEE_ACCOUNT: 'HIGH',
  SHARED_ACCOUNT: 'HIGH',
  BANK_CHANGED_UNVERIFIED: 'HIGH',
  DUPLICATE_PAYMENT: 'HIGH',
  BANK_CHANGED: 'MEDIUM',
  NEW_VENDOR: 'MEDIUM',
  UNUSUAL_AMOUNT: 'MEDIUM',
  NO_BILL: 'MEDIUM',
  SAME_PERSON: 'MEDIUM',
  SIMILAR_NAME: 'LOW',
  ROUND_AMOUNT: 'LOW',
};

export const FRAUD_WINDOW_DAYS = 30;
export const FRAUD_DUPLICATE_DAYS = 7;
export const FRAUD_UNUSUAL_MULTIPLE = 3;
export const FRAUD_ROUND_AMOUNT_FROM = '100000';

export interface FraudIndicator {
  code: FraudIndicatorCode;
  level: FraudLevel;
  detail: string;
}

/** A vendor payment to check: one waiting in a batch, or one already recorded. */
export interface PaymentToCheck {
  key: string;
  /** Payment date (planned for a batch). */
  date: string;
  amount: string;
  /** Bills it pays; empty for a payment set against nothing. */
  documentIds: string[];
  /** Who made the payment or the batch. */
  madeById: string;
}

export interface VendorFacts {
  contactId: string;
  name: string;
  createdOn: string;
  bank: { accountNumber: string; changedOn: string; changedById: string; verified: boolean } | null;
  /** Earlier posted payments (not void) to the vendor: key, date and amount. */
  payments: { key: string; date: string; amount: string }[];
}

export interface OrgFacts {
  /** Other vendors: name and normalised bank account number. */
  vendors: { contactId: string; name: string; accountNumber: string | null }[];
  /** Employees' salary account numbers, normalised, with the employee's name. */
  employeeAccounts: { name: string; accountNumber: string }[];
  /** Bills in more than one open batch item, by bill id: the keys of those items. */
  billsInOpenBatches: Map<string, string[]>;
}

const COMPANY_WORDS = /\b(private|pvt|limited|ltd|llp|inc|co|company|corp|corporation|the|and|m\/s|ms)\b/g;
/** A vendor name with case, punctuation, spaces and company words taken away. */
export function normaliseVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/m\/s/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(COMPANY_WORDS, ' ')
    .replace(/\s+/g, '');
}

/** Bank account numbers compared without spaces, dashes or leading zeros. */
export function normaliseAccountForMatch(n: string): string {
  return n.replace(/[\s-]/g, '').replace(/^0+/, '').toUpperCase();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const before = (days: number) => (days === 0 ? 'on the day of the payment' : `${plural(days, 'day')} before the payment`);

export function paymentFraudIndicators(p: PaymentToCheck, v: VendorFacts, org: OrgFacts, money: (amount: string) => string): FraudIndicator[] {
  const out: FraudIndicator[] = [];
  const add = (code: FraudIndicatorCode, detail: string) => out.push({ code, level: FRAUD_INDICATOR_LEVEL[code], detail });
  const acct = v.bank ? normaliseAccountForMatch(v.bank.accountNumber) : null;

  if (acct) {
    const emp = org.employeeAccounts.filter((e) => normaliseAccountForMatch(e.accountNumber) === acct);
    if (emp.length) add('EMPLOYEE_ACCOUNT', `The bank account is also the salary account of ${emp.map((e) => e.name).join(', ')}`);
    const shared = org.vendors.filter((o) => o.contactId !== v.contactId && o.accountNumber && normaliseAccountForMatch(o.accountNumber) === acct);
    if (shared.length) add('SHARED_ACCOUNT', `${shared.map((o) => o.name).join(', ')} ${shared.length === 1 ? 'has' : 'have'} the same bank account`);
  }

  if (v.bank) {
    const since = daysBetween(v.bank.changedOn, p.date);
    if (since >= 0 && since <= FRAUD_WINDOW_DAYS) {
      if (!v.bank.verified) add('BANK_CHANGED_UNVERIFIED', `Bank details changed ${before(since)} and not verified since`);
      else add('BANK_CHANGED', `Bank details changed ${before(since)} (verified)`);
    }
    if (v.bank.changedById === p.madeById && since >= 0 && since <= FRAUD_WINDOW_DAYS) add('SAME_PERSON', 'The person who changed the bank details also made this payment');
  }

  const amount = new D(p.amount);
  const dupes = v.payments.filter((o) => o.key !== p.key && new D(o.amount).eq(amount) && Math.abs(daysBetween(o.date, p.date)) <= FRAUD_DUPLICATE_DAYS);
  const inOtherBatches = p.documentIds.filter((id) => (org.billsInOpenBatches.get(id) ?? []).some((k) => k !== p.key));
  if (dupes.length) add('DUPLICATE_PAYMENT', `Another payment of ${money(p.amount)} to this vendor within ${FRAUD_DUPLICATE_DAYS} days (${dupes.map((d) => d.date).join(', ')})`);
  else if (inOtherBatches.length) add('DUPLICATE_PAYMENT', `${plural(inOtherBatches.length, 'bill')} also in another open payment batch`);

  const age = daysBetween(v.createdOn, p.date);
  if (age >= 0 && age <= FRAUD_WINDOW_DAYS) add('NEW_VENDOR', `The vendor was added ${before(age)}`);

  const yearBefore = v.payments.filter((o) => o.key !== p.key && o.date < p.date && o.date >= addDays(p.date, -365));
  if (yearBefore.length >= 3) {
    const largest = yearBefore.reduce((m, o) => D.max(m, new D(o.amount)), new D(0));
    if (largest.gt(0) && amount.gt(largest.times(FRAUD_UNUSUAL_MULTIPLE))) add('UNUSUAL_AMOUNT', `Over ${FRAUD_UNUSUAL_MULTIPLE} times the largest payment to this vendor in the year before (${money(largest.toFixed())})`);
  }

  if (!p.documentIds.length) add('NO_BILL', 'Not set against any bill');

  const name = normaliseVendorName(v.name);
  const similar = name ? org.vendors.filter((o) => o.contactId !== v.contactId && normaliseVendorName(o.name) === name) : [];
  if (similar.length) add('SIMILAR_NAME', `Another vendor has almost the same name: ${similar.map((o) => o.name).join(', ')}`);

  if (amount.gte(FRAUD_ROUND_AMOUNT_FROM) && amount.mod(1000).isZero()) add('ROUND_AMOUNT', `A large round amount (${money(p.amount)})`);

  const order: Record<FraudLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || FRAUD_INDICATORS.indexOf(a.code) - FRAUD_INDICATORS.indexOf(b.code));
}

/** The most serious level among the indicators, or null with none. */
export function fraudLevel(indicators: Pick<FraudIndicator, 'level'>[]): FraudLevel | null {
  for (const l of FRAUD_LEVELS) if (indicators.some((i) => i.level === l)) return l;
  return null;
}
