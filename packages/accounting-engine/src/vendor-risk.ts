/**
 * Vendor risk monitoring (AP-024): each active vendor's risk worked out from what the books
 * already hold (bank details and their changes, tax checks, delivery performance, how much is
 * bought from them, onboarding and overdue amounts), and whether a person needs to review it.
 *
 * Deterministic and explainable: every factor says what it was raised on. Nothing is scored by a
 * model or bought from an outside data provider. Amounts are decimal strings, never JS numbers.
 */
import { daysBetween } from './documents';
import { D } from './money';

export const VENDOR_RISK_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type VendorRiskLevel = (typeof VENDOR_RISK_LEVELS)[number];
export const VENDOR_RISK_LEVEL_LABEL: Record<VendorRiskLevel, string> = { NONE: 'None', LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' };

export const VENDOR_RISK_DECISIONS = ['ACCEPTED', 'MONITOR', 'STOP'] as const;
export type VendorRiskDecision = (typeof VENDOR_RISK_DECISIONS)[number];
export const VENDOR_RISK_DECISION_LABEL: Record<VendorRiskDecision, string> = {
  ACCEPTED: 'Risk accepted, keep buying',
  MONITOR: 'Keep buying, watch closely',
  STOP: 'Stop new orders',
};

/** Bank details changed this recently are flagged. */
export const VENDOR_BANK_CHANGE_DAYS = 30;
/** A vendor this new with a large share of purchases is flagged. */
export const VENDOR_NEW_DAYS = 90;
export const VENDOR_NEW_SHARE = '10';
/** A vendor with at least this share of purchases in the last twelve months is a concentration risk. */
export const VENDOR_CONCENTRATION_SHARE = '25';
/** Bills overdue by more than this many days are flagged. */
export const VENDOR_OVERDUE_DAYS = 60;
/** Days to the next review, suggested by level, and the longest allowed. */
export const VENDOR_REVIEW_AFTER_DAYS: Record<'LOW' | 'MEDIUM' | 'HIGH', number> = { HIGH: 30, MEDIUM: 90, LOW: 180 };
export const MAX_VENDOR_REVIEW_DAYS = 365;

export interface VendorRiskFacts {
  /** The day the vendor was added. */
  createdOn: string;
  /** Posted bills less vendor credits in the last twelve months, functional currency. */
  spend: string;
  /** The same for every vendor together. */
  totalSpend: string;
  /** Owed to the vendor now. */
  openPayable: string;
  /** Owed on bills more than VENDOR_OVERDUE_DAYS past their due date. */
  overdue: string;
  bank: { changedOn: string; verified: boolean; sameAccountAs: string[] } | null;
  /** Counts of supplier tax problems (AP-019) by severity. */
  tax: { high: number; medium: number };
  /** Vendor performance grade (AP-021) for the last twelve months. */
  grade: 'A' | 'B' | 'C' | 'D' | null;
  /** Vendor onboarding (AP-002): required for this organisation, and this vendor's status. */
  onboarding: { required: boolean; status: string | null };
}

export type VendorRiskFactorCode =
  | 'BANK_SHARED'
  | 'BANK_CHANGED_UNVERIFIED'
  | 'BANK_UNVERIFIED'
  | 'BANK_CHANGED_RECENTLY'
  | 'TAX_PROBLEMS'
  | 'POOR_PERFORMANCE'
  | 'CONCENTRATION'
  | 'NEW_VENDOR'
  | 'ONBOARDING_INCOMPLETE'
  | 'OVERDUE_PAYABLE';

export interface VendorRiskFactor {
  code: VendorRiskFactorCode;
  level: Exclude<VendorRiskLevel, 'NONE'>;
  /** Short name of the factor. */
  title: string;
  /** What it was raised on and what to do. */
  detail: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const RANK: Record<VendorRiskLevel, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
export const vendorRiskRank = (l: VendorRiskLevel) => RANK[l];

/** The vendor's share of purchases, in per cent to one decimal, or null when nothing was bought. */
export function vendorSpendShare(spend: string, total: string): string | null {
  const t = new D(total);
  if (t.lte(0) || new D(spend).lte(0)) return null;
  return new D(spend).div(t).times(100).toDecimalPlaces(1).toFixed(1);
}

/**
 * The risk factors found for one vendor, worst first. `money` formats an amount for reading.
 */
export function vendorRiskFactors(f: VendorRiskFacts, today: string, money: (amount: string) => string): VendorRiskFactor[] {
  const out: VendorRiskFactor[] = [];
  const owed = new D(f.openPayable);
  const share = vendorSpendShare(f.spend, f.totalSpend);
  /** Compared unrounded, so 24.99% is not taken as 25%. */
  const atLeast = (pct: string) => !!share && new D(f.spend).times(100).gte(new D(f.totalSpend).times(pct));
  if (f.bank) {
    const age = daysBetween(f.bank.changedOn, today);
    if (f.bank.sameAccountAs.length) {
      out.push({ code: 'BANK_SHARED', level: 'HIGH', title: 'Bank account shared with another vendor', detail: `The same bank account is on ${f.bank.sameAccountAs.join(', ')}. Payments meant for one vendor could reach another; confirm the account with each of them.` });
    }
    if (!f.bank.verified && age <= VENDOR_BANK_CHANGE_DAYS) {
      out.push({
        code: 'BANK_CHANGED_UNVERIFIED',
        level: owed.gt(0) ? 'HIGH' : 'MEDIUM',
        title: 'Bank details changed and not verified',
        detail: `The bank details were changed on ${longDate(f.bank.changedOn)} and nobody has verified them yet${owed.gt(0) ? `, with ${money(f.openPayable)} owed to the vendor` : ''}. Confirm the change with the vendor on a number you already have before paying.`,
      });
    } else if (!f.bank.verified && owed.gt(0)) {
      out.push({ code: 'BANK_UNVERIFIED', level: 'MEDIUM', title: 'Bank details not verified', detail: `${money(f.openPayable)} is owed to the vendor and their bank details have never been verified. Verify them before the next payment.` });
    } else if (f.bank.verified && age <= VENDOR_BANK_CHANGE_DAYS) {
      out.push({ code: 'BANK_CHANGED_RECENTLY', level: 'LOW', title: 'Bank details changed recently', detail: `The bank details were changed on ${longDate(f.bank.changedOn)} and verified since. Keep an eye on the first payment to the new account.` });
    }
  }
  if (f.tax.high || f.tax.medium) {
    const n = f.tax.high + f.tax.medium;
    out.push({
      code: 'TAX_PROBLEMS',
      level: f.tax.high ? 'HIGH' : 'MEDIUM',
      title: 'Tax problems',
      detail: `${n === 1 ? 'One problem' : `${n} problems`} with the vendor's GSTIN, PAN or the GST on their bills${f.tax.high ? `, ${f.tax.high === 1 ? 'one' : f.tax.high} serious` : ''}. Input tax credit or TDS is at risk; see Supplier tax checks.`,
    });
  }
  if (f.grade === 'D' || f.grade === 'C') {
    out.push({ code: 'POOR_PERFORMANCE', level: f.grade === 'D' ? 'MEDIUM' : 'LOW', title: `Performance grade ${f.grade}`, detail: `Late deliveries, rejected goods, billing differences or team reviews put the vendor at grade ${f.grade} for the last twelve months.` });
  }
  if (atLeast(VENDOR_CONCENTRATION_SHARE)) {
    out.push({ code: 'CONCENTRATION', level: 'MEDIUM', title: 'Large share of purchases', detail: `${share}% of purchases in the last twelve months (${money(f.spend)}) came from this vendor. If they stopped supplying, it would hurt; line up a second source.` });
  }
  const age = daysBetween(f.createdOn, today);
  if (age <= VENDOR_NEW_DAYS && atLeast(VENDOR_NEW_SHARE)) {
    out.push({ code: 'NEW_VENDOR', level: 'MEDIUM', title: 'New vendor with large purchases', detail: `Added on ${longDate(f.createdOn)}, and already ${share}% of purchases. Make sure the vendor was checked before the volume grew.` });
  }
  if (f.onboarding.required && f.onboarding.status !== 'APPROVED' && (new D(f.spend).gt(0) || owed.gt(0))) {
    out.push({ code: 'ONBOARDING_INCOMPLETE', level: 'MEDIUM', title: 'Onboarding not approved', detail: `Vendor onboarding is required, but this vendor's is ${f.onboarding.status ? f.onboarding.status.toLowerCase().replace('_', ' ') : 'not started'}, and they are already being billed.` });
  }
  if (new D(f.overdue).gt(0)) {
    out.push({ code: 'OVERDUE_PAYABLE', level: 'LOW', title: 'Paying late', detail: `${money(f.overdue)} owed to the vendor is more than ${VENDOR_OVERDUE_DAYS} days past due. The vendor may hold back supplies or change terms.` });
  }
  return out.sort((a, b) => RANK[b.level] - RANK[a.level]);
}

export function vendorRiskLevel(factors: Pick<VendorRiskFactor, 'level'>[]): VendorRiskLevel {
  return factors.reduce<VendorRiskLevel>((m, f) => (RANK[f.level] > RANK[m] ? f.level : m), 'NONE');
}

export interface LastVendorRiskReview {
  level: VendorRiskLevel;
  factorCodes: string[];
  reviewedOn: string;
  nextReviewOn: string;
}
export type VendorReviewNeed = 'NEVER_REVIEWED' | 'NEW_RISK' | 'REVIEW_DUE' | null;

/**
 * Whether a person needs to look at the vendor now: a medium or high risk never reviewed, a factor
 * or a higher level that the last review did not see, or a review date reached.
 */
export function vendorReviewNeed(level: VendorRiskLevel, factors: Pick<VendorRiskFactor, 'code'>[], last: LastVendorRiskReview | null, today: string): { need: VendorReviewNeed; newFactors: string[] } {
  const codes = factors.map((f) => f.code);
  if (!last) return { need: RANK[level] >= RANK.MEDIUM ? 'NEVER_REVIEWED' : null, newFactors: RANK[level] >= RANK.MEDIUM ? codes : [] };
  const newFactors = codes.filter((c) => !last.factorCodes.includes(c));
  if (RANK[level] >= RANK.MEDIUM && (newFactors.length || RANK[level] > RANK[last.level])) return { need: 'NEW_RISK', newFactors };
  if (RANK[level] >= RANK.LOW && last.nextReviewOn <= today) return { need: 'REVIEW_DUE', newFactors };
  return { need: null, newFactors };
}

export class VendorRiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorRiskError';
  }
}

/** Checks a review before it is recorded. */
export function validateVendorRiskReview(input: { decision: string; note: string; reviewedOn: string; nextReviewOn: string }, today: string): void {
  if (!(VENDOR_RISK_DECISIONS as readonly string[]).includes(input.decision)) throw new VendorRiskError('Choose a decision');
  if (input.note.trim().length < 5) throw new VendorRiskError('Say what was looked at and why this decision');
  if (input.reviewedOn > today) throw new VendorRiskError('The review date cannot be in the future');
  if (input.nextReviewOn <= input.reviewedOn) throw new VendorRiskError('The next review must be after this one');
  if (daysBetween(input.reviewedOn, input.nextReviewOn) > MAX_VENDOR_REVIEW_DAYS) throw new VendorRiskError(`The next review must be within ${MAX_VENDOR_REVIEW_DAYS} days`);
}
