import { addDays, daysBetween } from './documents';
import { dec, type Dec } from './money';

/**
 * Unusual bill checks (Directive Part 7, AP-031 invoice anomaly detection). Rule-based checks of a
 * vendor bill against that vendor's earlier bills and the vendor's bank details, run before the
 * bill is paid. Every finding says what was compared, so a person can judge it; nothing here
 * blocks a bill on its own.
 */

export type BillCheckCode =
  | 'SAME_VENDOR_REFERENCE'
  | 'AMOUNT_ABOVE_USUAL'
  | 'PRICE_JUMP'
  | 'NEW_ACCOUNT'
  | 'FIRST_BILL'
  | 'BANK_DETAILS_CHANGED'
  | 'BANK_DETAILS_UNVERIFIED'
  | 'DATED_AHEAD'
  | 'OLD_BILL'
  | 'ROUND_AMOUNT';
export type BillCheckSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export const BILL_CHECK_LABEL: Record<BillCheckCode, string> = {
  SAME_VENDOR_REFERENCE: 'Vendor invoice number used before',
  AMOUNT_ABOVE_USUAL: 'Much more than usual',
  PRICE_JUMP: 'Price went up',
  NEW_ACCOUNT: 'New expense account for this vendor',
  FIRST_BILL: 'First bill from this vendor',
  BANK_DETAILS_CHANGED: 'Bank details changed recently',
  BANK_DETAILS_UNVERIFIED: 'Bank details not verified',
  DATED_AHEAD: 'Dated in the future',
  OLD_BILL: 'Old bill',
  ROUND_AMOUNT: 'Round amount without tax',
};

/** Thresholds; the defaults suit most books. */
export const BILL_CHECK_DEFAULTS = {
  /** A bill this many times the median of the vendor's earlier bills is unusual. */
  amountMultiple: '3',
  /** Earlier bills needed before amount and account checks run. */
  minHistory: 3,
  /** A unit price this much (percent) above the last price for the same item. */
  priceJumpPercent: '25',
  /** Bank details changed this many days before the bill (or after it). */
  bankChangeDays: 30,
  /** A bill dated more than this many days before it was entered. */
  oldBillDays: 180,
  /** Round amounts at or above this, in the functional currency, with no tax. */
  roundAmountFrom: '10000',
};

export interface BillCheckLine {
  description: string | null;
  accountId: string;
  accountName?: string;
  quantity: string;
  unitPrice: string;
  taxAmount: string;
}

export interface BillCheckBill {
  id: string;
  number: string | null;
  /** The vendor's own invoice number. */
  reference: string | null;
  issueDate: string;
  /** In the functional currency. */
  total: string;
  currency: string;
  lines: BillCheckLine[];
}

export interface BillCheckInput {
  bill: BillCheckBill;
  /** The vendor's other bills that were posted (not void), newest first or in any order. */
  history: BillCheckBill[];
  bank: { changedAt: string | null; verifiedAt: string | null } | null;
  today: string;
  settings?: Partial<typeof BILL_CHECK_DEFAULTS>;
}

export interface BillCheckFinding {
  code: BillCheckCode;
  severity: BillCheckSeverity;
  label: string;
  detail: string;
  /** Earlier bills the finding refers to. */
  relatedIds: string[];
}

const SEVERITY_RANK: Record<BillCheckSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const itemKey = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normRef = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function median(values: Dec[]): Dec {
  const v = [...values].sort((a, b) => a.comparedTo(b));
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : v[m - 1]!.plus(v[m]!).div(2);
}

const fmt = (d: Dec, currency: string) => `${currency} ${d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/** The findings for one bill, most serious first. */
export function checkBill(input: BillCheckInput): BillCheckFinding[] {
  const s = { ...BILL_CHECK_DEFAULTS, ...input.settings };
  const { bill, today } = input;
  const history = input.history.filter((h) => h.id !== bill.id);
  const out: BillCheckFinding[] = [];
  const add = (code: BillCheckCode, severity: BillCheckSeverity, detail: string, relatedIds: string[] = []) => out.push({ code, severity, label: BILL_CHECK_LABEL[code], detail, relatedIds });
  const total = dec(bill.total);

  const ref = normRef(bill.reference);
  if (ref) {
    const same = history.filter((h) => normRef(h.reference) === ref);
    if (same.length) add('SAME_VENDOR_REFERENCE', 'HIGH', `Vendor invoice ${bill.reference} is also on ${same.map((h) => h.number ?? 'a bill').join(', ')}. The same invoice may be entered twice.`, same.map((h) => h.id));
  }

  if (history.length >= s.minHistory) {
    const usual = median(history.map((h) => dec(h.total)));
    if (usual.gt(0) && total.gte(usual.times(dec(s.amountMultiple)))) {
      add('AMOUNT_ABOVE_USUAL', 'MEDIUM', `${fmt(total, bill.currency)} is ${total.div(usual).toDecimalPlaces(1).toFixed()} times the usual ${fmt(usual, bill.currency)} (median of ${history.length} earlier bills).`);
    }
    const used = new Set(history.flatMap((h) => h.lines.map((l) => l.accountId)));
    const fresh = [...new Map(bill.lines.filter((l) => !used.has(l.accountId)).map((l) => [l.accountId, l])).values()];
    if (fresh.length) add('NEW_ACCOUNT', 'LOW', `${fresh.map((l) => l.accountName ?? 'An account').join(', ')} ${fresh.length > 1 ? 'were' : 'was'} not used on this vendor's ${history.length} earlier bills.`);
  } else if (!history.length) {
    add('FIRST_BILL', 'LOW', 'There are no earlier posted bills from this vendor to compare with. Check the vendor is real and the bill was ordered.');
  }

  // Unit price against the latest earlier bill with the same item description.
  const byDate = [...history].sort((a, b) => b.issueDate.localeCompare(a.issueDate));
  for (const l of bill.lines) {
    const key = itemKey(l.description);
    if (!key || dec(l.unitPrice).lte(0)) continue;
    for (const h of byDate) {
      const prev = h.lines.find((x) => itemKey(x.description) === key && dec(x.unitPrice).gt(0));
      if (!prev) continue;
      const rise = dec(l.unitPrice).minus(prev.unitPrice).div(prev.unitPrice).times(100);
      if (rise.gte(dec(s.priceJumpPercent))) add('PRICE_JUMP', 'MEDIUM', `${l.description}: ${dec(l.unitPrice).toFixed(2)} a unit against ${dec(prev.unitPrice).toFixed(2)} on ${h.number ?? 'the last bill'} (${h.issueDate}), up ${rise.toDecimalPlaces(0).toFixed()}%.`, [h.id]);
      break;
    }
  }

  if (input.bank) {
    if (input.bank.changedAt) {
      const days = daysBetween(input.bank.changedAt, bill.issueDate);
      if (days <= s.bankChangeDays || daysBetween(input.bank.changedAt, today) <= s.bankChangeDays) add('BANK_DETAILS_CHANGED', 'HIGH', `The vendor's bank details were changed on ${input.bank.changedAt}${days < 0 ? ', after the bill date' : days <= s.bankChangeDays ? `, ${days} days before the bill date` : ''}. Confirm the change with the vendor by phone before paying.`);
    }
    if (!input.bank.verifiedAt) add('BANK_DETAILS_UNVERIFIED', 'MEDIUM', 'The vendor\'s bank details have not been verified by a second person.');
  }

  if (bill.issueDate > today) add('DATED_AHEAD', 'MEDIUM', `The bill is dated ${bill.issueDate}, after today.`);
  else if (bill.issueDate < addDays(today, -s.oldBillDays)) add('OLD_BILL', 'LOW', `The bill is dated ${bill.issueDate}, more than ${s.oldBillDays} days ago. Check it was not paid already.`);

  const tax = bill.lines.reduce((a, l) => a.plus(dec(l.taxAmount)), dec('0'));
  if (tax.isZero() && total.gte(dec(s.roundAmountFrom)) && total.mod(1000).isZero()) add('ROUND_AMOUNT', 'LOW', `${fmt(total, bill.currency)} is a round amount with no tax, which is unusual for a supplier invoice.`);

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** A stable fingerprint of the findings, so a review covers exactly what was seen. */
export function billCheckFingerprint(findings: readonly BillCheckFinding[]): string {
  return findings.map((f) => f.code).sort().join(',');
}
